"""Training-studio worker: runs the jobs the admin starts from the command centre.

    RASED_DATABASE_URL=... RASED_TRAINING_DIR=/data/training RASED_MODELS_DIR=/data/models \
        python -m rased_trainer.worker

For each job: extract pose windows from every labelled clip (cached), train on the
train split, choose the threshold on validation, score on the test split (and score the
currently active model on the same test split), export ONNX, and register the result as
a *candidate* model. Switching it on is a separate, gated decision in the UI.
"""
from __future__ import annotations

import json
import logging
import os
import time
import traceback
from pathlib import Path
from typing import Any, Optional

import numpy as np
import psycopg

log = logging.getLogger("rased.trainer")

DSN = os.environ.get("RASED_DATABASE_URL", "postgresql://rased:rased@localhost:5432/rased")
TRAINING_DIR = Path(os.environ.get("RASED_TRAINING_DIR", "./data/training"))
MODELS_DIR = Path(os.environ.get("RASED_MODELS_DIR", "./data/models"))
POSE_MODEL = os.environ.get("RASED_POSE_MODEL", "models/yolo11n-pose.pt")
DEVICE = os.environ.get("RASED_DEVICE") or None
POLL_S = float(os.environ.get("RASED_TRAINER_POLL", "5"))


class Cancelled(Exception):
    pass


class Job:
    """Progress, log and cancellation for one training job, written straight to the database."""

    def __init__(self, conn: psycopg.Connection, row: dict[str, Any]) -> None:
        self.conn, self.id, self.params = conn, row["id"], row["params"] or {}
        self._last_beat = 0.0

    def _exec(self, sql: str, args: tuple) -> None:
        with self.conn.cursor() as cur:
            cur.execute(sql, args)
        self.conn.commit()

    def log(self, msg: str) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}\n"
        log.info("job %s: %s", self.id, msg)
        self._exec("UPDATE training_jobs SET log = log || %s, heartbeat_at = now() WHERE id = %s", (line, self.id))

    def progress(self, p: float, stage: Optional[str] = None) -> None:
        now = time.time()
        if stage is None and now - self._last_beat < 2:
            return
        self._last_beat = now
        self._exec("UPDATE training_jobs SET progress = %s, stage = COALESCE(%s, stage), heartbeat_at = now() WHERE id = %s",
                   (round(min(max(p, 0.0), 1.0), 3), stage, self.id))

    def cancelled(self) -> bool:
        with self.conn.cursor() as cur:
            cur.execute("SELECT status FROM training_jobs WHERE id = %s", (self.id,))
            row = cur.fetchone()
        return not row or row[0] == "cancelled"

    def check(self) -> None:
        if self.cancelled():
            raise Cancelled()


def claim(conn: psycopg.Connection) -> Optional[dict[str, Any]]:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """UPDATE training_jobs SET status = 'running', started_at = now(), heartbeat_at = now(), stage = 'starting'
               WHERE id = (SELECT id FROM training_jobs WHERE status = 'queued' ORDER BY created_at
                           FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING id, params"""
        )
        row = cur.fetchone()
    conn.commit()
    return row


def recover(conn: psycopg.Connection) -> None:
    """Jobs left 'running' by a crashed worker are marked failed, so the studio is never stuck."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE training_jobs SET status = 'failed', finished_at = now(),
                      log = log || '[worker restarted: job interrupted]' || chr(10)
               WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '10 minutes')"""
        )
    conn.commit()


def load_items(conn: psycopg.Connection) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """SELECT id::text, label, split, media_path, features_path FROM dataset_items
               WHERE task = 'fight' AND NOT excluded AND split IS NOT NULL ORDER BY created_at"""
        )
        return cur.fetchall()


def extract(job: Job, items: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    """Pose windows per item, cached next to the clip so the next job only processes new clips."""
    from ultralytics import YOLO

    from .features import clip_windows

    model = None
    out: dict[str, np.ndarray] = {}
    todo = [it for it in items if not (it["features_path"] and (TRAINING_DIR / it["features_path"]).exists())]
    job.log(f"{len(items)} labelled clips, {len(todo)} need pose extraction")
    done = 0
    for it in items:
        cache = it["features_path"]
        if cache and (TRAINING_DIR / cache).exists():
            out[it["id"]] = np.load(TRAINING_DIR / cache)["X"]
            continue
        job.check()
        model = model or YOLO(POSE_MODEL)
        clip = TRAINING_DIR / it["media_path"]
        if not clip.exists():
            job.log(f"missing file for item {it['id'][:8]}, skipped")
            continue
        X = clip_windows(model, str(clip), device=DEVICE)
        rel = Path("features") / f"{it['id']}.npz"
        (TRAINING_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(TRAINING_DIR / rel, X=X)
        job._exec("UPDATE dataset_items SET features_path = %s, windows = %s WHERE id = %s", (str(rel), len(X), it["id"]))
        out[it["id"]] = X
        done += 1
        job.progress(0.45 * done / max(len(todo), 1), "features")
        if len(X) == 0:
            job.log(f"no people found in item {it['id'][:8]}: it adds nothing to training")
    return out


def build(items: list[dict[str, Any]], feats: dict[str, np.ndarray], split: str) -> dict[str, np.ndarray]:
    X, y, v = [], [], []
    for idx, it in enumerate(items):
        if it["split"] != split or it["id"] not in feats or not len(feats[it["id"]]):
            continue
        w = feats[it["id"]]
        X.append(w)
        y += [1 if it["label"] == "positive" else 0] * len(w)
        v += [idx] * len(w)
    if not X:
        return {"X": np.zeros((0, 32, 170), np.float32), "y": np.zeros(0, np.int64), "video": np.zeros(0, np.int64)}
    return {"X": np.concatenate(X).astype(np.float32), "y": np.array(y, np.int64), "video": np.array(v, np.int64)}


def run(conn: psycopg.Connection, job: Job) -> dict[str, Any]:
    from .train import evaluate, evaluate_onnx, export_onnx, fit

    job.progress(0.0, "features")
    items = load_items(conn)
    feats = extract(job, items)
    data = {s: build(items, feats, s) for s in ("train", "val", "test")}
    for s, d in data.items():
        classes = set(np.unique(d["y"]).tolist())
        if classes != {0, 1}:
            raise ValueError(f"the {s} split needs clips of both kinds with people visible (has {sorted(classes) or 'none'})")
    counts = {s: {"windows": int(len(d["y"])), "clips": int(len(np.unique(d["video"]))),
                  "positiveClips": int(len(np.unique(d["video"][d["y"] == 1])))} for s, d in data.items()}
    job.log(f"data: {json.dumps(counts)}")

    job.progress(0.45, "training")
    epochs = int(job.params.get("epochs", 30))
    model, history = fit(data["train"], data["val"], epochs=epochs, log=job.log,
                         progress=lambda f: job.progress(0.45 + 0.45 * f), should_stop=job.cancelled)

    job.progress(0.9, "evaluation")
    metrics = evaluate(model, data["val"], data["test"])
    metrics["history"] = history
    with conn.cursor() as cur:
        cur.execute("SELECT path, threshold, version FROM model_versions WHERE task = 'fight' AND status = 'active'")
        active = cur.fetchone()
        cur.execute("SELECT COALESCE(max(version), 0) + 1 FROM model_versions WHERE task = 'fight'")
        version = cur.fetchone()[0]
    if active and Path(active[0]).exists():
        metrics["baseline"] = evaluate_onnx(active[0], data["test"], float(active[1]))
        metrics["baseline"]["version"] = active[2]
        job.log(f"active model v{active[2]} on the same test set: F1={metrics['baseline']['video']['f1']}, "
                f"recall={metrics['baseline']['video']['recall']}")
    t = metrics["test"]["video"]
    job.log(f"new model on the test set: F1={t['f1']}, recall={t['recall']}, precision={t['precision']} "
            f"at threshold {metrics['threshold']}")

    job.progress(0.95, "export")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    path = (MODELS_DIR / f"fight-v{version}.onnx").resolve()
    diff = export_onnx(model, path, data["test"]["X"])
    job.log(f"exported {path.name} (onnx vs torch max diff {diff:.1e})")

    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO model_versions (task, version, path, threshold, metrics, data, job_id)
               VALUES ('fight', %s, %s, %s, %s, %s, %s) RETURNING id""",
            (version, str(path), metrics["threshold"], json.dumps(metrics), json.dumps(counts), job.id),
        )
        mv = cur.fetchone()[0]
        cur.execute("UPDATE training_jobs SET model_version_id = %s WHERE id = %s", (mv, job.id))
    conn.commit()
    return {"version": version, "test": t, "threshold": metrics["threshold"],
            "baseline": metrics.get("baseline", {}).get("video")}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    TRAINING_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            with psycopg.connect(DSN) as conn:
                recover(conn)
                while True:
                    row = claim(conn)
                    if not row:
                        time.sleep(POLL_S)
                        continue
                    job = Job(conn, row)
                    status, result = "succeeded", None
                    try:
                        job.log("job started")
                        result = run(conn, job)
                        job.log("done: the new model is waiting for review in the Models tab")
                    except (Cancelled, InterruptedError):
                        status = "cancelled"
                        job.log("cancelled")
                    except Exception as e:  # the job fails, the worker keeps running
                        status = "failed"
                        job.log(f"failed: {e}")
                        log.error(traceback.format_exc())
                        result = {"error": str(e)}
                    with conn.cursor() as cur:
                        cur.execute(
                            """UPDATE training_jobs SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE %s END,
                                      finished_at = now(), progress = CASE WHEN %s = 'succeeded' THEN 1 ELSE progress END,
                                      result = %s, stage = %s WHERE id = %s""",
                            (status, status, json.dumps(result) if result else None, status, job.id),
                        )
                    conn.commit()
        except psycopg.OperationalError as e:
            log.warning("database unavailable (%s), retrying", e)
            time.sleep(5)


if __name__ == "__main__":
    main()
