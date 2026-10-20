"""Turn a folder of labelled videos into pose-sequence windows for the fight classifier.

Expected layout (RWF-2000 uses exactly this; your own staged clips can too):

    DATA_ROOT/
      train/Fight/*.avi|mp4     train/NonFight/*.avi|mp4
      val/Fight/...             val/NonFight/...

Output: one .npz per split with
    X        (N, WINDOW, FEATURE_DIM) float32
    y        (N,) 0/1
    video    (N,) index into `videos`
    videos   list of video paths

Usage:
    python training/prepare_fight_data.py --data /data/RWF-2000 --out training/data --device 0
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "vision"))
from rased_trainer.features import best_pair, video_tracks  # noqa: E402
from rased_vision.pose_features import WINDOW, pair_window_features  # noqa: E402

VIDEO_EXT = {".avi", ".mp4", ".mov", ".mkv"}
LABELS = {"Fight": 1, "NonFight": 0, "fight": 1, "nonfight": 0, "non_fight": 0}


def build_split(model, root: Path, split: str, device, imgsz: int, stride: int):
    X, y, vid, videos = [], [], [], []
    split_dir = root / split
    for label_dir in sorted(p for p in split_dir.iterdir() if p.is_dir()):
        if label_dir.name not in LABELS:
            continue
        label = LABELS[label_dir.name]
        files = sorted(p for p in label_dir.iterdir() if p.suffix.lower() in VIDEO_EXT)
        for k, path in enumerate(files):
            tracks, n, aspect = video_tracks(model, str(path), device, imgsz)
            vi = len(videos)
            videos.append(str(path))
            starts = list(range(0, max(1, n - WINDOW + 1), stride))
            for s in starts:
                pair = best_pair(tracks, s, aspect)
                if pair is None:
                    continue
                X.append(pair_window_features(pair[0], pair[1], aspect))
                y.append(label)
                vid.append(vi)
            if k % 25 == 0:
                print(f"[{split}/{label_dir.name}] {k + 1}/{len(files)} videos, {len(X)} windows", flush=True)
    return (np.stack(X) if X else np.zeros((0, WINDOW, 170), np.float32), np.array(y, np.int64),
            np.array(vid, np.int64), np.array(videos))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="dataset root with train/ and val/")
    ap.add_argument("--out", default="training/data")
    ap.add_argument("--pose-model", default="services/vision/models/yolo11n-pose.pt")
    ap.add_argument("--device", default=None, help="'0' for the first GPU, 'cpu' for CPU")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--stride", type=int, default=8, help="window step in frames at TARGET_FPS")
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.pose_model)
    os.makedirs(args.out, exist_ok=True)
    root = Path(args.data)
    for split in ("train", "val"):
        if not (root / split).exists():
            continue
        X, y, vid, videos = build_split(model, root, split, args.device, args.imgsz, args.stride)
        out = Path(args.out) / f"{split}.npz"
        np.savez_compressed(out, X=X, y=y, video=vid, videos=videos)
        print(f"wrote {out}: {len(y)} windows from {len(videos)} videos, {int(y.sum())} fight windows")


if __name__ == "__main__":
    main()
