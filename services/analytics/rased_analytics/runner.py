"""Periodic job: read metrics and events, write tension scores, forecasts and reports.

    RASED_DATABASE_URL=postgresql://rased:rased@localhost:5432/rased python -m rased_analytics.runner
    python -m rased_analytics.runner --once        # single pass (used by tests and cron)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import timedelta

import pandas as pd
import psycopg

from .core import anomaly_scores, baseline, bucket_features, deviations, forecast, precursors, tension

log = logging.getLogger("rased.analytics")

HISTORY_DAYS = int(os.environ.get("RASED_HISTORY_DAYS", "42"))
INTERVAL_S = int(os.environ.get("RASED_ANALYTICS_EVERY", "900"))


def _frame(conn: psycopg.Connection, sql: str, params: dict) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def read(conn: psycopg.Connection, since: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    p = {"since": since.to_pydatetime()}
    m = _frame(conn, """SELECT camera_id, area_id::text AS area_id, period_start, occupancy_avg, motion_avg,
                               cluster_max, runners_max
                        FROM zone_metrics WHERE zone_id IS NULL AND area_id IS NOT NULL AND period_start >= %(since)s""", p)
    e = _frame(conn, """SELECT area_id::text AS area_id, started_at, severity, status, type
                        FROM events WHERE area_id IS NOT NULL AND started_at >= %(since)s""", p)
    for df, col in ((m, "period_start"), (e, "started_at")):
        if not df.empty:
            df[col] = pd.to_datetime(df[col], utc=True)
    for col in ("occupancy_avg", "motion_avg"):
        if col in m:
            m[col] = m[col].astype(float)
    return m, e


def run_once(dsn: str) -> dict:
    t0 = time.time()
    now = pd.Timestamp.now(tz="UTC")
    since = now - timedelta(days=HISTORY_DAYS)
    with psycopg.connect(dsn) as conn:
        metrics, events = read(conn, since)
        if metrics.empty:
            log.info("no metrics yet")
            return {"areas": 0}
        feats = bucket_features(metrics, events)
        dev = deviations(feats, baseline(feats))
        scored = tension(dev, anomaly_scores(dev))

        share_cols = [c for c in scored.columns if c.startswith("share_")]
        z_cols = [c for c in scored.columns if c.startswith("z_")]
        rows = [
            (r.area_id, r.bucket.to_pydatetime(), float(r.tension), float(r.anomaly),
             json.dumps({"shares": {c[6:]: float(getattr(r, c)) for c in share_cols},
                         "z": {c[2:]: round(float(getattr(r, c)), 2) for c in z_cols}}))
            for r in scored.itertuples()
        ]
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO area_scores (area_id, bucket, tension, anomaly, components)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (area_id, bucket) DO UPDATE
                   SET tension = EXCLUDED.tension, anomaly = EXCLUDED.anomaly, components = EXCLUDED.components""",
                rows)

            for area_id, hist in scored.groupby("area_id"):
                fc = forecast(hist[["bucket", "tension"]], 24, now=now)
                cur.executemany(
                    """INSERT INTO area_forecasts (area_id, generated_at, hour, pred, lower_bound, upper_bound, method)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    [(area_id, now.to_pydatetime(), h.hour.to_pydatetime(), float(h.pred), float(h.lower),
                      float(h.upper), h.method) for h in fc.itertuples()])
            cur.execute("DELETE FROM area_forecasts WHERE generated_at < %s", ((now - timedelta(days=2)).to_pydatetime(),))

            serious = events[(events["status"] == "confirmed") & (events["severity"].isin(["high", "critical"]))]
            report = precursors(scored, serious)
            report["generated_for_days"] = HISTORY_DAYS
            cur.execute("INSERT INTO analytics_reports (kind, data) VALUES ('precursors', %s)", (json.dumps(report),))
        conn.commit()
    took = round(time.time() - t0, 1)
    log.info("scored %d buckets in %d areas (%ss)", len(rows), scored["area_id"].nunique(), took)
    return {"areas": int(scored["area_id"].nunique()), "buckets": len(rows), "seconds": took}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    dsn = os.environ.get("RASED_DATABASE_URL", "postgresql://rased:rased@localhost:5432/rased")
    while True:
        try:
            run_once(dsn)
        except Exception:
            log.exception("analytics pass failed")
            if args.once:
                raise
        if args.once:
            break
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    main()
