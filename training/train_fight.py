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
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "vision"))
from fight_model import FightNet, FightNetProb  # noqa: E402
from metrics import best_threshold, summarize, video_scores, write_report  # noqa: E402
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


def augment(x: torch.Tensor) -> torch.Tensor:
    """Mirror left/right and add small noise: fights look the same flipped."""
    if torch.rand(1).item() < 0.5:
        x = x.clone()
        pos = x[..., :68].view(*x.shape[:2], 2, 17, 2)
        pos[..., 0] = -pos[..., 0]
        vel = x[..., 68:136].view(*x.shape[:2], 2, 17, 2)
        vel[..., 0] = -vel[..., 0]
    return x + torch.randn_like(x) * 0.02


@torch.no_grad()
def predict(model: nn.Module, X: np.ndarray, device: str, batch: int = 512) -> np.ndarray:
    model.eval()
    out = []
    for i in range(0, len(X), batch):
        xb = torch.from_numpy(X[i:i + batch]).to(device)
        out.append(torch.sigmoid(model(xb)).cpu().numpy())
    return np.concatenate(out) if out else np.zeros(0)


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

    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.synthetic:
        train, val = synthetic(80, 1), synthetic(30, 2)
    else:
        train, val = load(Path(args.data) / "train.npz"), load(Path(args.data) / "val.npz")
    print(f"train windows={len(train['y'])} (fight {train['y'].mean():.0%})  val windows={len(val['y'])}  device={device}")

    pos_weight = torch.tensor([(1 - train["y"].mean()) / max(train["y"].mean(), 1e-6)], device=device)
    loader = DataLoader(TensorDataset(torch.from_numpy(train["X"]), torch.from_numpy(train["y"]).float()),
                        batch_size=args.batch, shuffle=True, drop_last=False)
    model = FightNet(FEATURE_DIM).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    best_f1, best_epoch, history = -1.0, 0, []
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0, total = time.time(), 0.0
        for xb, yb in loader:
            xb, yb = augment(xb.to(device)), yb.to(device)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item() * len(yb)
        sched.step()
        vp = predict(model, val["X"], device)
        vs, vl = video_scores(vp, val["video"], val["y"])
        m = summarize(vs, vl, 0.5)
        history.append({"epoch": epoch, "loss": total / len(train["y"]), **{k: m[k] for k in ("precision", "recall", "f1", "auc")}})
        print(f"epoch {epoch:3d} loss={total / len(train['y']):.4f} video f1={m['f1']:.3f} "
              f"recall={m['recall']:.3f} auc={m['auc']:.3f} ({time.time() - t0:.1f}s)")
        if m["f1"] > best_f1:
            best_f1, best_epoch = m["f1"], epoch
            torch.save(model.state_dict(), out / "best.pt")
        elif epoch - best_epoch >= args.patience:
            print(f"early stop: no improvement for {args.patience} epochs")
            break

    model.load_state_dict(torch.load(out / "best.pt", map_location=device))
    vp = predict(model, val["X"], device)
    vs, vl = video_scores(vp, val["video"], val["y"])
    threshold = best_threshold(vs, vl, args.recall_target)
    report = {
        "threshold": round(threshold, 3),
        "recall_target": args.recall_target,
        "best_epoch": best_epoch,
        "window": summarize(vp, val["y"], threshold),
        "video": summarize(vs, vl, threshold),
        "history": history,
        "synthetic": args.synthetic,
    }
    write_report(out / "report.json", report)
    (out / "threshold.txt").write_text(f"{threshold:.3f}\n")

    # Export: probability output, dynamic batch, fixed window length.
    export = FightNetProb(model.to("cpu")).eval()
    dummy = torch.zeros(1, WINDOW, FEATURE_DIM)
    torch.onnx.export(export, dummy, out / "fight.onnx", input_names=["x"], output_names=["prob"],
                      dynamic_axes={"x": {0: "batch"}, "prob": {0: "batch"}}, opset_version=17, dynamo=False)
    # Check the ONNX file gives the same answers as PyTorch.
    import onnxruntime as ort

    sess = ort.InferenceSession(str(out / "fight.onnx"), providers=["CPUExecutionProvider"])
    sample = val["X"][:16]
    onnx_p = sess.run(None, {"x": sample})[0].reshape(-1)
    torch_p = export(torch.from_numpy(sample)).detach().numpy().reshape(-1)
    diff = float(np.abs(onnx_p - torch_p).max())
    print(f"ONNX export ok, max |onnx - torch| = {diff:.2e}")
    print(json.dumps({k: report[k] for k in ("threshold", "video")}, indent=2))


if __name__ == "__main__":
    main()
