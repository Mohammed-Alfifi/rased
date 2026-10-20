"""Behaviour analytics for facility areas.

All functions here are pure (pandas in, pandas out) so they can be tested without a
database. Prediction is about PLACES AND TIMES, never about individuals: inputs are
aggregate counts per area, with no identity of anyone.

Pipeline per area, on 15-minute buckets:
  1. features   occupancy, motion, largest group, runners, weighted incidents
  2. baseline   robust normal level for each hour of the week (median / MAD)
  3. deviation  how far the current bucket is from its normal level (robust z)
  4. anomaly    optional IsolationForest score over the feature vector
  5. tension    0..100 index combining incidents, deviations and anomaly
  6. forecast   tension for the next 24 hours with an interval
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

BUCKET = "15min"
FEATURES = ["occupancy", "motion", "cluster", "runners", "incidents"]
SEVERITY_WEIGHT = {"low": 0.25, "medium": 0.5, "high": 1.0, "critical": 2.0}


@dataclass
class Weights:
    """How much each signal adds to tension. Tuned on pilot data; documented in docs/analytics.md."""
    incidents: float = 0.9
    cluster: float = 0.25
    motion: float = 0.15
    runners: float = 0.25
    occupancy: float = 0.05
    anomaly: float = 0.6


def bucket_features(metrics: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """Aggregate camera-level metric rows and events into per-area 15-minute features.

    metrics columns: area_id, period_start (datetime), occupancy_avg, motion_avg, cluster_max, runners_max
    events columns:  area_id, started_at (datetime), severity, status
    """
    if metrics.empty:
        return pd.DataFrame(columns=["area_id", "bucket", *FEATURES])
    m = metrics.copy()
    m["bucket"] = m["period_start"].dt.floor(BUCKET)
    # several cameras per area: occupancy adds up, the others take the max / mean
    per_cam = m.groupby(["area_id", "bucket", "camera_id"]).agg(
        occupancy=("occupancy_avg", "mean"), motion=("motion_avg", "mean"),
        cluster=("cluster_max", "max"), runners=("runners_max", "max"))
    feats = per_cam.groupby(["area_id", "bucket"]).agg(
        occupancy=("occupancy", "sum"), motion=("motion", "mean"),
        cluster=("cluster", "max"), runners=("runners", "max")).reset_index()

    if events is not None and not events.empty:
        e = events[events["status"] != "dismissed"].copy()
        e["bucket"] = e["started_at"].dt.floor(BUCKET)
        e["w"] = e["severity"].map(SEVERITY_WEIGHT).fillna(0.5)
        inc = e.groupby(["area_id", "bucket"])["w"].sum().rename("incidents").reset_index()
        feats = feats.merge(inc, on=["area_id", "bucket"], how="left")
    else:
        feats["incidents"] = 0.0
    feats["incidents"] = feats["incidents"].fillna(0.0)
    return feats.sort_values(["area_id", "bucket"]).reset_index(drop=True)


def hour_of_week(ts: pd.Series) -> pd.Series:
    return ts.dt.dayofweek * 24 + ts.dt.hour


def baseline(feats: pd.DataFrame, min_samples: int = 8) -> pd.DataFrame:
    """Median and MAD for each area x hour-of-week, falling back to hour-of-day
    while there is less than `min_samples` history for a slot."""
    f = feats.copy()
    f["how"] = hour_of_week(f["bucket"])
    f["hod"] = f["bucket"].dt.hour
    rows = []
    for col in FEATURES:
        def mad(x):
            return float(np.median(np.abs(x - np.median(x))))
        w = f.groupby(["area_id", "how"])[col].agg(["median", mad, "count"]).reset_index()
        d = f.groupby(["area_id", "hod"])[col].agg(["median", mad, "count"]).reset_index()
        w["hod"] = w["how"] % 24
        w = w.merge(d, on=["area_id", "hod"], suffixes=("", "_d"))
        use_day = w["count"] < min_samples
        w.loc[use_day, "median"] = w.loc[use_day, "median_d"]
        w.loc[use_day, "mad"] = w.loc[use_day, "mad_d"]
        w["feature"] = col
        rows.append(w[["area_id", "how", "feature", "median", "mad"]])
    return pd.concat(rows, ignore_index=True)


def deviations(feats: pd.DataFrame, base: pd.DataFrame) -> pd.DataFrame:
    """Robust z-score of each feature against its hour-of-week baseline (0 = normal)."""
    f = feats.copy()
    f["how"] = hour_of_week(f["bucket"])
    for col in FEATURES:
        b = base[base["feature"] == col][["area_id", "how", "median", "mad"]]
        f = f.merge(b, on=["area_id", "how"], how="left")
        scale = 1.4826 * f["mad"].fillna(0)
        # small floor so a perfectly flat history does not explode the score
        floor = {"occupancy": 1.0, "motion": 0.05, "cluster": 1.0, "runners": 0.5, "incidents": 0.5}[col]
        f[f"z_{col}"] = ((f[col] - f["median"].fillna(f[col])) / np.maximum(scale, floor)).clip(-5, 8)
        f = f.drop(columns=["median", "mad"])
    return f


def anomaly_scores(dev: pd.DataFrame, min_rows: int = 200, seed: int = 0) -> pd.Series:
    """IsolationForest over the deviation vector, per area. 0 = typical, 1 = most unusual.
    Areas with too little history get 0 (not enough evidence to call anything unusual)."""
    from sklearn.ensemble import IsolationForest

    out = pd.Series(0.0, index=dev.index)
    cols = [f"z_{c}" for c in FEATURES]
    for area, idx in dev.groupby("area_id").groups.items():
        part = dev.loc[idx, cols].fillna(0.0)
        if len(part) < min_rows:
            continue
        model = IsolationForest(n_estimators=150, contamination="auto", random_state=seed).fit(part.values)
        raw = -model.score_samples(part.values)  # higher = more anomalous
        lo, hi = np.percentile(raw, 50), np.percentile(raw, 99.5)
        out.loc[idx] = np.clip((raw - lo) / max(hi - lo, 1e-6), 0, 1)
    return out


def tension(dev: pd.DataFrame, anomaly: pd.Series, w: Weights = Weights()) -> pd.DataFrame:
    """0..100 tension index per area bucket, with the share of each component.

    Incidents decay over two hours, so one fight keeps the area 'warm' for a while.
    Only positive deviations count: an emptier, calmer area than usual is not tense.
    """
    d = dev.copy()
    d["anomaly"] = anomaly
    d = d.sort_values(["area_id", "bucket"])
    # exponentially decayed incident load, half-life 1 hour (4 buckets); scaled so that one
    # confirmed critical incident on its own puts the area at about 55-60
    d["incident_load"] = d.groupby("area_id")["incidents"].transform(lambda s: s.ewm(halflife=4, adjust=False).mean() * 6.0)
    parts = {
        "incidents": w.incidents * d["incident_load"],
        "cluster": w.cluster * d["z_cluster"].clip(lower=0),
        "motion": w.motion * d["z_motion"].clip(lower=0),
        "runners": w.runners * d["z_runners"].clip(lower=0),
        "occupancy": w.occupancy * d["z_occupancy"].clip(lower=0),
        "anomaly": w.anomaly * d["anomaly"] * 2,
    }
    s = sum(parts.values())
    d["tension"] = (100 * (1 - np.exp(-s / 2.0))).round(1)
    total = s.replace(0, np.nan)
    for k, v in parts.items():
        d[f"share_{k}"] = (v / total).fillna(0).round(3)
    return d


def forecast(history: pd.DataFrame, horizon_h: int = 24, now: pd.Timestamp | None = None) -> pd.DataFrame:
    """Hourly tension forecast for one area.

    history: columns bucket, tension (any frequency). Uses Holt-Winters with a daily
    season once there are two weeks of history, else a seasonal profile (same hour on
    previous days) blended with the current level. Returns hour, pred, lower, upper.
    """
    h = history.set_index("bucket")["tension"].resample("1h").mean().interpolate(limit=3).dropna()
    now = now or (h.index.max() if len(h) else pd.Timestamp.utcnow().floor("h"))
    future = pd.date_range(now.floor("h") + pd.Timedelta(hours=1), periods=horizon_h, freq="1h")
    if len(h) < 24:
        level = float(h.iloc[-6:].mean()) if len(h) else 0.0
        return pd.DataFrame({"hour": future, "pred": level, "lower": max(0.0, level - 15), "upper": min(100.0, level + 15),
                             "method": "level"})

    if len(h) >= 24 * 14:
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        model = ExponentialSmoothing(h.values, trend=None, seasonal="add", seasonal_periods=24,
                                     initialization_method="estimated").fit(optimized=True)
        pred = model.forecast(horizon_h)
        resid = np.std(h.values - model.fittedvalues)
        method = "holt-winters"
    else:
        profile = h.groupby(h.index.hour).mean()
        recent_gap = float((h.iloc[-6:] - profile.reindex(h.index[-6:].hour).values).mean())
        decay = np.exp(-np.arange(1, horizon_h + 1) / 6.0)  # today's offset fades over ~6 h
        pred = profile.reindex(future.hour).values + recent_gap * decay
        resid = float(np.std(h.values - profile.reindex(h.index.hour).values))
        method = "seasonal-profile"
    pred = np.clip(pred, 0, 100)
    band = 1.64 * max(resid, 3.0)
    return pd.DataFrame({"hour": future, "pred": pred.round(1), "lower": np.clip(pred - band, 0, 100).round(1),
                         "upper": np.clip(pred + band, 0, 100).round(1), "method": method})


def hotspots(forecasts: pd.DataFrame, current: pd.DataFrame, threshold: float = 60.0, window_h: int = 12) -> pd.DataFrame:
    """Areas expected to be tense in the next `window_h` hours, highest first.

    forecasts: area_id, hour, pred      current: area_id, tension (latest bucket)
    """
    if forecasts.empty:
        return pd.DataFrame(columns=["area_id", "peak", "peak_at", "current", "rising"])
    start = forecasts["hour"].min()
    f = forecasts[forecasts["hour"] < start + pd.Timedelta(hours=window_h)]
    idx = f.groupby("area_id")["pred"].idxmax()
    peak = f.loc[idx, ["area_id", "pred", "hour"]].rename(columns={"pred": "peak", "hour": "peak_at"})
    peak = peak.merge(current[["area_id", "tension"]].rename(columns={"tension": "current"}), on="area_id", how="left")
    peak["rising"] = peak["peak"] > peak["current"].fillna(0) + 10
    return peak[peak["peak"] >= threshold].sort_values("peak", ascending=False).reset_index(drop=True)


def precursors(scores: pd.DataFrame, incidents: pd.DataFrame, lookback_h: int = 2) -> dict:
    """What the signals looked like before confirmed serious incidents, against normal times.

    scores: area_id, bucket, tension, z_* columns.   incidents: area_id, started_at
    Returns the mean of each signal in the `lookback_h` hours before incidents and in all
    other buckets, plus the lift (before / other). This is the evidence for the gate
    "the index rises before incidents".
    """
    if scores.empty or incidents.empty:
        return {"incidents": 0}
    s = scores.copy()
    s["before"] = False
    for _, inc in incidents.iterrows():
        mask = (s["area_id"] == inc["area_id"]) & (s["bucket"] < inc["started_at"]) & \
               (s["bucket"] >= inc["started_at"] - pd.Timedelta(hours=lookback_h))
        s.loc[mask, "before"] = True
    cols = ["tension"] + [c for c in s.columns if c.startswith("z_") and c != "z_incidents"]
    before, other = s[s["before"]], s[~s["before"]]
    out = {"incidents": int(len(incidents)), "lookback_hours": lookback_h, "signals": {}}
    for c in cols:
        b, o = float(before[c].mean()), float(other[c].mean())
        out["signals"][c] = {"before": round(b, 3), "other": round(o, 3),
                             "lift": round(b / o, 2) if c == "tension" and o > 0 else round(b - o, 3)}
    return out
