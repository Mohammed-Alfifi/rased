"""Training loop, evaluation and ONNX export, shared by training/train_fight.py and the studio worker."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from rased_vision.pose_features import FEATURE_DIM, WINDOW

from .metrics import best_threshold, summarize, video_scores
from .model import FightNet, FightNetProb

Split = dict  # {"X": (n, WINDOW, F) float32, "y": (n,) int, "video": (n,) int}
Log = Callable[[str], None]


def augment(x: torch.Tensor) -> torch.Tensor:
    """Mirror left/right and add small noise: a fight looks the same flipped."""
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
    out = [torch.sigmoid(model(torch.from_numpy(X[i:i + batch]).to(device))).cpu().numpy() for i in range(0, len(X), batch)]
    return np.concatenate(out) if out else np.zeros(0)


def fit(train: Split, val: Split, epochs: int = 30, lr: float = 1e-3, batch: int = 128, patience: int = 8,
        seed: int = 7, log: Log = print, progress: Optional[Callable[[float], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None, workdir: Optional[Path] = None) -> tuple[nn.Module, list]:
    """Train FightNet, keeping the epoch with the best video-level F1 on validation."""
    torch.manual_seed(seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    pos = float(train["y"].mean())
    pos_weight = torch.tensor([(1 - pos) / max(pos, 1e-6)], device=device)
    loader = DataLoader(TensorDataset(torch.from_numpy(train["X"]), torch.from_numpy(train["y"]).float()),
                        batch_size=batch, shuffle=True)
    model = FightNet(FEATURE_DIM).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    best_f1, best_epoch, best_state, history = -1.0, 0, None, []
    log(f"train windows={len(train['y'])} (fight {pos:.0%}), val windows={len(val['y'])}, device={device}")
    for epoch in range(1, epochs + 1):
        if should_stop and should_stop():
            raise InterruptedError("cancelled")
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
        history.append({"epoch": epoch, "loss": round(total / len(train["y"]), 4), **{k: m[k] for k in ("precision", "recall", "f1", "auc")}})
        log(f"epoch {epoch:3d}  loss={total / len(train['y']):.4f}  val F1={m['f1']:.3f}  recall={m['recall']:.3f}  ({time.time() - t0:.1f}s)")
        if progress:
            progress(epoch / epochs)
        if m["f1"] > best_f1:
            best_f1, best_epoch = m["f1"], epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        elif epoch - best_epoch >= patience:
            log(f"early stop: no improvement for {patience} epochs (best epoch {best_epoch})")
            break
    model.load_state_dict(best_state)
    if workdir:
        torch.save(best_state, workdir / "best.pt")
    return model, history


def evaluate(model: nn.Module, val: Split, test: Split, recall_target: float = 0.85) -> dict:
    """Pick the alert threshold on validation, then report on the untouched test set."""
    device = next(model.parameters()).device.type
    vp = predict(model, val["X"], device)
    vs, vl = video_scores(vp, val["video"], val["y"])
    threshold = best_threshold(vs, vl, recall_target)
    tp = predict(model, test["X"], device)
    ts, tl = video_scores(tp, test["video"], test["y"])
    return {
        "threshold": round(threshold, 3),
        "recall_target": recall_target,
        "val": {"video": summarize(vs, vl, threshold)},
        "test": {"window": summarize(tp, test["y"], threshold), "video": summarize(ts, tl, threshold)},
    }


def evaluate_onnx(path: str, test: Split, threshold: float) -> dict:
    """Score an existing exported model on a test set (used to compare against the active model)."""
    import onnxruntime as ort

    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    probs = np.concatenate([sess.run(None, {name: test["X"][i:i + 256]})[0].reshape(-1) for i in range(0, len(test["X"]), 256)])
    ts, tl = video_scores(probs, test["video"], test["y"])
    return {"video": summarize(ts, tl, threshold), "threshold": threshold}


def export_onnx(model: nn.Module, path: Path, check: Optional[np.ndarray] = None) -> float:
    """Export with a probability output; returns the max difference against PyTorch on `check`."""
    export = FightNetProb(model.to("cpu")).eval()
    torch.onnx.export(export, torch.zeros(1, WINDOW, FEATURE_DIM), str(path), input_names=["x"], output_names=["prob"],
                      dynamic_axes={"x": {0: "batch"}, "prob": {0: "batch"}}, opset_version=17, dynamo=False)
    if check is None or not len(check):
        return 0.0
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    sample = check[:16]
    a = sess.run(None, {"x": sample})[0].reshape(-1)
    b = export(torch.from_numpy(sample)).detach().numpy().reshape(-1)
    return float(np.abs(a - b).max())
