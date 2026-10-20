"""Train, evaluate and export the fight classifier.

    python training/train_fight.py --data training/data --out training/runs/fight
    python training/train_fight.py --synthetic --epochs 3   # pipeline smoke test only

Outputs in --out:
    best.pt              PyTorch weights
    fight.onnx           model for the vision service (set RASED_FIGHT_MODEL to this path)
    report.json / .md    precision, recall, F1, AUC, confusion matrix at window and video level
    threshold.txt        the chosen alert threshold (set it as the camera param `fight_threshold`)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "vision"))
from rased_trainer.metrics import write_report  # noqa: E402
from rased_trainer.train import evaluate, export_onnx, fit  # noqa: E402
from rased_vision.pose_features import FEATURE_DIM, WINDOW  # noqa: E402


def synthetic(n_videos: int, seed: int) -> dict:
    """Random pose-like windows where 'fight' windows have stronger oscillating velocities.
    Only for checking that the pipeline runs end to end."""
    rng = np.random.default_rng(seed)
    X, y, video = [], [], []
    for v in range(n_videos):
        label = v % 2
        for _ in range(6):
            base = rng.normal(0, 1, (WINDOW, FEATURE_DIM)).astype(np.float32) * 0.3
            if label:
                tt = np.arange(WINDOW)[:, None]
                base[:, 68:136] += np.sin(tt * rng.uniform(0.8, 1.6) + rng.uniform(0, 3, 68)) * rng.uniform(0.6, 1.2)
            X.append(base)
            y.append(label)
            video.append(v)
    return {"X": np.stack(X), "y": np.array(y), "video": np.array(video)}


def load(path: Path) -> dict:
    d = np.load(path, allow_pickle=True)
    return {"X": d["X"].astype(np.float32), "y": d["y"].astype(np.int64), "video": d["video"].astype(np.int64)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/data")
    ap.add_argument("--out", default="training/runs/fight")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--recall-target", type=float, default=0.85)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--synthetic", action="store_true", help="smoke test with generated data")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.synthetic:
        train, val, test = synthetic(80, 1), synthetic(30, 2), synthetic(30, 3)
    else:
        train, val = load(Path(args.data) / "train.npz"), load(Path(args.data) / "val.npz")
        test_path = Path(args.data) / "test.npz"
        # RWF-2000 has no separate test split: fall back to validation (stated in the report)
        test = load(test_path) if test_path.exists() else val

    model, history = fit(train, val, epochs=args.epochs, lr=args.lr, batch=args.batch, patience=args.patience,
                         seed=args.seed, workdir=out)
    m = evaluate(model, val, test, args.recall_target)
    report = {
        "threshold": m["threshold"],
        "recall_target": args.recall_target,
        "window": m["test"]["window"],
        "video": m["test"]["video"],
        "validation": m["val"]["video"],
        "test_is_validation": test is val,
        "history": history,
        "synthetic": args.synthetic,
    }
    write_report(out / "report.json", report)
    (out / "threshold.txt").write_text(f"{m['threshold']:.3f}\n")
    diff = export_onnx(model, out / "fight.onnx", val["X"])
    print(f"ONNX export ok, max |onnx - torch| = {diff:.2e}")
    print(json.dumps({k: report[k] for k in ("threshold", "video")}, indent=2))


if __name__ == "__main__":
    main()
