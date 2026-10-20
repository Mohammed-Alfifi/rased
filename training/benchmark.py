"""Measure inference speed of model formats and how many cameras one server can carry.

    python training/benchmark.py --video samples/demo.mp4 \
        --models services/vision/models/yolo11n-pose.pt services/vision/models/yolo11n-pose.onnx

Writes a Markdown table (and JSON) with mean / p95 latency, frames per second and the
estimated number of cameras at the target processing rate (default 15 fps per camera,
the plan's success threshold).
"""
from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path

import cv2
import numpy as np


def frames_from(video: str | None, n: int) -> list[np.ndarray]:
    if video:
        cap = cv2.VideoCapture(video)
        out = []
        while len(out) < n:
            ok, f = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, f = cap.read()
                if not ok:
                    break
            out.append(f)
        cap.release()
        if out:
            return out
    rng = np.random.default_rng(0)
    return [rng.integers(0, 255, (720, 1280, 3), dtype=np.uint8) for _ in range(n)]


def bench(path: str, frames: list[np.ndarray], imgsz: int, device: str | None, warmup: int = 5) -> dict:
    from ultralytics import YOLO

    model = YOLO(path, task="pose" if "pose" in Path(path).name else "detect")
    for f in frames[:warmup]:
        model.predict(f, imgsz=imgsz, device=device, verbose=False)
    times = []
    for f in frames:
        t = time.perf_counter()
        model.predict(f, imgsz=imgsz, device=device, verbose=False)
        times.append((time.perf_counter() - t) * 1000)
    arr = np.array(times)
    return {"model": Path(path).name, "mean_ms": round(float(arr.mean()), 1),
            "p95_ms": round(float(np.percentile(arr, 95)), 1), "fps": round(1000 / float(arr.mean()), 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--video", default=None)
    ap.add_argument("--frames", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--device", default=None)
    ap.add_argument("--target-fps", type=float, default=15.0, help="processing rate needed per camera")
    ap.add_argument("--out", default="training/runs/benchmark")
    args = ap.parse_args()

    frames = frames_from(args.video, args.frames)
    rows = [bench(m, frames, args.imgsz, args.device) for m in args.models]
    for r in rows:
        r["cameras_at_target"] = int(r["fps"] // args.target_fps)
    info = {"platform": platform.platform(), "processor": platform.processor(), "device": args.device or "auto",
            "imgsz": args.imgsz, "target_fps": args.target_fps, "results": rows}
    try:
        import torch
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
    except Exception:
        pass

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "benchmark.json").write_text(json.dumps(info, indent=2))
    lines = [f"# Inference benchmark ({info.get('gpu', info['processor'] or 'CPU')}, imgsz {args.imgsz})", "",
             f"| Model | Mean ms | p95 ms | FPS | Cameras at {args.target_fps:g} fps |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {r['model']} | {r['mean_ms']} | {r['p95_ms']} | {r['fps']} | {r['cameras_at_target']} |" for r in rows]
    (out / "benchmark.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
