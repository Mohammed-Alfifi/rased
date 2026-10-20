"""Evaluate the whole detection pipeline on labelled clips (the plan's acceptance gates).

Folder layout: one folder per expected alert type, plus `normal` for clips with no incident.

    CLIPS/
      fight/*.mp4          person_down/*.mp4     gathering/*.mp4   ...
      normal/*.mp4         (everyday activity: walking, sitting, sport, meals)

    python training/evaluate_clips.py --clips /data/eval-clips --out training/runs/eval

For each type: recall = clips of that type where the system raised that alert.
For normal clips: false alerts per hour of video.
Writes report.json in the shape the API expects (POST /api/reports/model-eval):
    {"fight": {"video": {"recall": ...}}, "fall": {"recall": ...}, "types": {...}, "falseAlertsPerHour": ...}
Use only clips you are authorised to use (public datasets, staged recordings).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "vision"))
from rased_vision.config import Settings  # noqa: E402
from rased_vision.detector import Detector  # noqa: E402
from rased_vision.models import Camera  # noqa: E402
from rased_vision.offline import analyse  # noqa: E402

VIDEO_EXT = {".mp4", ".avi", ".mov", ".mkv"}


def duration(path: Path) -> float:
    cap = cv2.VideoCapture(str(path))
    n, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS) or 25
    cap.release()
    return n / fps if n > 0 else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", default="training/runs/eval")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--params", default="{}", help='camera params JSON, e.g. \'{"fight_threshold": 0.7}\'')
    args = ap.parse_args()

    settings = Settings()
    detector = None
    root = Path(args.clips)
    per_type: dict[str, dict] = {}
    normal_alerts, normal_seconds = [], 0.0
    t0 = time.time()
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        files = sorted(p for p in folder.iterdir() if p.suffix.lower() in VIDEO_EXT)
        hits = 0
        for f in files:
            # a fresh tracker per clip; reuse the loaded weights
            detector = Detector(settings.pose_model, settings.object_model, imgsz=settings.imgsz, device=settings.device)
            cam = Camera(id="eval", name=f.name, url=str(f), params=json.loads(args.params))
            events = analyse(str(f), cam, settings, args.fps, detector=detector)
            types = {e["type"] for e in events}
            if folder.name == "normal":
                normal_seconds += duration(f)
                normal_alerts += [{"clip": f.name, "type": e["type"], "second": e["videoSecond"]} for e in events
                                  if e["type"] not in ("camera_tamper",)]
            elif folder.name in types:
                hits += 1
            print(f"[{folder.name}] {f.name}: {sorted(types) or 'no alerts'}", flush=True)
        if folder.name != "normal" and files:
            per_type[folder.name] = {"clips": len(files), "detected": hits, "recall": round(hits / len(files), 4)}

    hours = normal_seconds / 3600
    report = {
        "types": per_type,
        "fight": {"video": per_type.get("fight", {})},
        "fall": per_type.get("person_down", {}),
        "normalClipsHours": round(hours, 3),
        "falseAlertsOnNormal": len(normal_alerts),
        "falseAlertsPerHour": round(len(normal_alerts) / hours, 2) if hours else None,
        "falseAlertExamples": normal_alerts[:50],
        "fightMode": "classifier" if settings.fight_model else "rules",
        "seconds": round(time.time() - t0),
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    lines = ["# Pipeline evaluation on labelled clips", "", "| Alert type | Clips | Detected | Recall |", "| --- | --- | --- | --- |"]
    lines += [f"| {k} | {v['clips']} | {v['detected']} | {v['recall']:.0%} |" for k, v in per_type.items()]
    lines += ["", f"Normal footage: {hours:.2f} h, {len(normal_alerts)} false alerts"
              + (f" ({report['falseAlertsPerHour']} per hour)" if hours else "")]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
