"""Clip -> pose-feature windows, shared by the command-line scripts and the training studio."""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

from rased_vision.pose_features import FEATURE_DIM, TARGET_FPS, WINDOW, pair_window_features, wrist_energy


def video_tracks(model, path: str, device: Optional[str] = None, imgsz: int = 640):
    """Pose tracking at TARGET_FPS. Returns ({track_id: {frame_index: keypoints}}, frames, aspect)."""
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / TARGET_FPS))
    tracks: dict[int, dict[int, np.ndarray]] = {}
    idx = n = 0
    aspect = 16 / 9
    model.predictor = None  # fresh tracker for every clip
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            h, w = frame.shape[:2]
            aspect = w / h
            res = model.track(frame, persist=True, tracker="bytetrack.yaml", classes=[0], imgsz=imgsz,
                              verbose=False, device=device)[0]
            if res.boxes is not None and res.boxes.id is not None and res.keypoints is not None:
                kps = res.keypoints.data.cpu().numpy()
                for tid, kp in zip(res.boxes.id.int().cpu().numpy(), kps):
                    kp = kp.astype(np.float32).copy()
                    kp[:, 0] /= w
                    kp[:, 1] /= h
                    tracks.setdefault(int(tid), {})[n] = kp
            n += 1
        idx += 1
    cap.release()
    return tracks, n, aspect


def best_pair(tracks, start: int, aspect: float):
    """The two people with the most arm movement in this window (or one person and nobody)."""
    window = range(start, start + WINDOW)
    seqs = {tid: [frames.get(i) for i in window] for tid, frames in tracks.items()}
    seqs = {tid: s for tid, s in seqs.items() if sum(x is not None for x in s) >= WINDOW // 3}
    if not seqs:
        return None
    energy = {tid: wrist_energy(s, aspect) for tid, s in seqs.items()}
    ranked = sorted(energy, key=energy.get, reverse=True)
    a = seqs[ranked[0]]
    b = seqs[ranked[1]] if len(ranked) > 1 else [None] * WINDOW
    return a, b


def clip_windows(model, path: str, stride: int = 8, device: Optional[str] = None, imgsz: int = 640) -> np.ndarray:
    """All feature windows of one clip, shape (n, WINDOW, FEATURE_DIM). Empty if nobody was seen."""
    tracks, n, aspect = video_tracks(model, path, device, imgsz)
    out = []
    for s in range(0, max(1, n - WINDOW + 1), stride):
        pair = best_pair(tracks, s, aspect)
        if pair is not None:
            out.append(pair_window_features(pair[0], pair[1], aspect))
    return np.stack(out) if out else np.zeros((0, WINDOW, FEATURE_DIM), np.float32)
