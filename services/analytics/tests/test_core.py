import numpy as np
import pandas as pd

from rased_analytics.core import (anomaly_scores, baseline, bucket_features, deviations, forecast, hotspots,
                                  precursors, tension)


def synthetic(days: int = 21, spike_at: pd.Timestamp | None = None, seed: int = 0):
    """Two areas with a daily rhythm. Area B has a crowding build-up before an incident."""
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2026-09-01", tz="UTC")
    idx = pd.date_range(start, periods=days * 24 * 4, freq="15min")
    rows = []
    for area in ("A", "B"):
        for t in idx:
            daily = 1 + np.sin((t.hour - 6) / 24 * 2 * np.pi)
            rows.append({"camera_id": f"{area}1", "area_id": area, "period_start": t,
                         "occupancy_avg": 10 * daily + rng.normal(0, 1), "motion_avg": 0.3 + 0.1 * daily + rng.normal(0, 0.03),
                         "cluster_max": int(2 + 2 * daily + rng.integers(0, 2)), "runners_max": int(rng.random() < 0.05)})
    m = pd.DataFrame(rows)
    events = pd.DataFrame(columns=["area_id", "started_at", "severity", "status"])
    if spike_at is not None:
        pre = (m["area_id"] == "B") & (m["period_start"] >= spike_at - pd.Timedelta(hours=2)) & (m["period_start"] < spike_at)
        m.loc[pre, "cluster_max"] += 9
        m.loc[pre, "motion_avg"] += 0.5
        m.loc[pre, "runners_max"] += 3
        events = pd.DataFrame([{"area_id": "B", "started_at": spike_at, "severity": "critical", "status": "confirmed"}])
    return m, events


def scored(m, e):
    feats = bucket_features(m, e)
    dev = deviations(feats, baseline(feats))
    return tension(dev, anomaly_scores(dev))


def test_features_and_baseline_shapes():
    m, e = synthetic(7)
    feats = bucket_features(m, e)
    assert set(feats["area_id"]) == {"A", "B"}
    assert len(feats) == 2 * 7 * 96
    base = baseline(feats)
    assert {"occupancy", "motion", "cluster", "runners", "incidents"} == set(base["feature"])


def test_normal_days_stay_calm():
    m, e = synthetic(21)
    s = scored(m, e)
    assert s["tension"].between(0, 100).all()
    assert s["tension"].median() < 25


def test_tension_rises_before_and_at_incident():
    spike = pd.Timestamp("2026-09-18 20:00", tz="UTC")
    m, e = synthetic(21, spike_at=spike)
    s = scored(m, e)
    b = s[s["area_id"] == "B"].set_index("bucket")["tension"]
    before = b[spike - pd.Timedelta(hours=2): spike - pd.Timedelta(minutes=15)].mean()
    normal = b[: spike - pd.Timedelta(days=1)].median()
    assert before > normal + 20
    assert b[spike] >= 50  # a critical incident alone keeps the area tense


def test_precursor_report_shows_lift():
    spike = pd.Timestamp("2026-09-18 20:00", tz="UTC")
    m, e = synthetic(21, spike_at=spike)
    report = precursors(scored(m, e), e)
    assert report["incidents"] == 1
    assert report["signals"]["tension"]["lift"] > 2
    assert report["signals"]["z_cluster"]["lift"] > 1


def test_forecast_follows_daily_rhythm():
    m, e = synthetic(21)
    s = scored(m, e)
    a = s[s["area_id"] == "A"][["bucket", "tension"]]
    fc = forecast(a, 24)
    assert len(fc) == 24
    assert (fc["lower"] <= fc["pred"]).all() and (fc["pred"] <= fc["upper"]).all()
    assert fc["method"].iloc[0] == "holt-winters"


def test_short_history_uses_profile_or_level():
    m, e = synthetic(3)
    s = scored(m, e)
    fc = forecast(s[s["area_id"] == "A"][["bucket", "tension"]], 24)
    assert fc["method"].iloc[0] == "seasonal-profile"
    tiny = forecast(pd.DataFrame({"bucket": pd.date_range("2026-01-01", periods=8, freq="15min", tz="UTC"),
                                  "tension": [10.0] * 8}), 24)
    assert tiny["method"].iloc[0] == "level"


def test_hotspots_ranks_high_forecasts():
    hours = pd.date_range("2026-10-01 00:00", periods=24, freq="1h", tz="UTC")
    fc = pd.concat([
        pd.DataFrame({"area_id": "A", "hour": hours, "pred": 20.0}),
        pd.DataFrame({"area_id": "B", "hour": hours, "pred": np.r_[np.full(5, 30.0), 75.0, np.full(18, 30.0)]}),
    ])
    hs = hotspots(fc, pd.DataFrame({"area_id": ["A", "B"], "tension": [20.0, 30.0]}))
    assert list(hs["area_id"]) == ["B"]
    assert bool(hs.loc[0, "rising"])
