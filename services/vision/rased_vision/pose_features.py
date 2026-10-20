"""Pose features for the fight classifier.

This module is imported by BOTH the live pipeline and training/ so the model sees
exactly the same features in training and in production. Change it only together
with retraining.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

TARGET_FPS = 15
WINDOW = 32  # frames at TARGET_FPS, about 2.1 seconds
N_KP = 17
FEATURE_DIM = 2 * N_KP * 2 * 2 + 2 * N_KP  # positions + velocities for 2 people, plus confidences = 170

L_SH, R_SH, L_HIP, R_HIP = 5, 6, 11, 12
L_WR, R_WR = 9, 10


def _torso(kp: np.ndarray) -> Optional[float]:
    if kp is None:
        return None
    pts = kp[[L_SH, R_SH, L_HIP, R_HIP]]
    if (pts[:, 2] < 0.2).any():
        return None
    sh = pts[:2, :2].mean(axis=0)
    hip = pts[2:, :2].mean(axis=0)
    return float(np.linalg.norm(sh - hip))


def _hip_center(kp: np.ndarray) -> Optional[np.ndarray]:
    if kp is None:
        return None
    pts = kp[[L_HIP, R_HIP, L_SH, R_SH]]
    good = pts[pts[:, 2] >= 0.2]
    if len(good) == 0:
        return None
    return good[:, :2].mean(axis=0)


def pair_window_features(
    seq_a: Sequence[Optional[np.ndarray]],
    seq_b: Sequence[Optional[np.ndarray]],
    aspect: float = 16 / 9,
) -> np.ndarray:
    """Build a (WINDOW, FEATURE_DIM) matrix from two keypoint sequences.

    Each element of seq_a / seq_b is a (17, 3) array of x, y (normalized 0..1) and
    confidence, or None when the person was not seen in that frame. Sequences must
    already be sampled at TARGET_FPS and have length WINDOW.
    """
    assert len(seq_a) == WINDOW and len(seq_b) == WINDOW
    pos = np.zeros((WINDOW, 2, N_KP, 2), dtype=np.float32)
    conf = np.zeros((WINDOW, 2, N_KP), dtype=np.float32)

    torsos = [t for t in (_torso(k) for k in list(seq_a) + list(seq_b)) if t]
    scale = float(np.median(torsos)) if torsos else 0.1
    scale = max(scale, 1e-3)

    for t in range(WINDOW):
        frames = [seq_a[t], seq_b[t]]
        centers = [c for c in (_hip_center(k) for k in frames) if c is not None]
        center = np.mean(centers, axis=0) if centers else np.array([0.5, 0.5])
        for p, kp in enumerate(frames):
            if kp is None:
                continue
            xy = kp[:, :2].astype(np.float32).copy()
            xy[:, 0] = (xy[:, 0] - center[0]) * aspect
            xy[:, 1] = xy[:, 1] - center[1]
            pos[t, p] = xy / scale
            conf[t, p] = kp[:, 2]

    vel = np.zeros_like(pos)
    vel[1:] = (pos[1:] - pos[:-1]) * TARGET_FPS
    # Velocities only where both frames saw the keypoint
    seen = conf > 0.2
    both = np.zeros_like(seen)
    both[1:] = seen[1:] & seen[:-1]
    vel *= both[..., None]
    vel = np.clip(vel, -50, 50) / 10.0

    feats = np.concatenate(
        [pos.reshape(WINDOW, -1), vel.reshape(WINDOW, -1), conf.reshape(WINDOW, -1)], axis=1
    )
    return feats.astype(np.float32)


def resample(times: Sequence[float], items: Sequence, end_t: float, n: int = WINDOW, fps: int = TARGET_FPS) -> list:
    """Pick the item nearest to each of n evenly spaced timestamps ending at end_t.

    Returns None for a slot when no item lies within half a frame period of it.
    """
    out = []
    times = np.asarray(times, dtype=np.float64)
    step = 1.0 / fps
    for i in range(n):
        target = end_t - (n - 1 - i) * step
        if len(times) == 0:
            out.append(None)
            continue
        j = int(np.argmin(np.abs(times - target)))
        out.append(items[j] if abs(times[j] - target) <= step * 0.75 else None)
    return out


def wrist_energy(seq: Sequence[Optional[np.ndarray]], aspect: float = 16 / 9) -> float:
    """Mean wrist speed in torso lengths per second. Used by the rule-based fallback."""
    speeds = []
    torsos = [t for t in (_torso(k) for k in seq) if t]
    scale = float(np.median(torsos)) if torsos else None
    if not scale:
        return 0.0
    for a, b in zip(seq[:-1], seq[1:]):
        if a is None or b is None:
            continue
        for w in (L_WR, R_WR):
            if a[w, 2] < 0.3 or b[w, 2] < 0.3:
                continue
            dx = (b[w, 0] - a[w, 0]) * aspect
            dy = b[w, 1] - a[w, 1]
            speeds.append((dx * dx + dy * dy) ** 0.5 / scale * TARGET_FPS)
    return float(np.mean(speeds)) if speeds else 0.0
