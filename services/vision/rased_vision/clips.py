"""Event clips: keep the last N seconds of frames and write a short video around each event.

Faces are blurred in every saved clip and snapshot (privacy by default).
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger(__name__)

NOSE, L_EYE, R_EYE, L_EAR, R_EAR, L_SH, R_SH = 0, 1, 2, 3, 4, 5, 6


def blur_faces(frame: np.ndarray, people: list[tuple[tuple[float, float, float, float], Optional[np.ndarray]]]) -> np.ndarray:
    """Blur the head of every person. Uses head keypoints when present, else the top of the box."""
    out = frame.copy()
    h, w = out.shape[:2]
    for bbox, kp in people:
        x1, y1, x2, y2 = bbox
        bw, bh = (x2 - x1) * w, (y2 - y1) * h
        region = None
        if kp is not None:
            head = kp[[NOSE, L_EYE, R_EYE, L_EAR, R_EAR]]
            good = head[head[:, 2] > 0.3]
            if len(good):
                cx, cy = good[:, 0].mean() * w, good[:, 1].mean() * h
                size = max(bw * 0.45, bh * 0.14, 12)
                region = (cx - size, cy - size, cx + size, cy + size)
        if region is None:
            region = (x1 * w, y1 * h, x2 * w, y1 * h + bh * 0.22)
        rx1, ry1, rx2, ry2 = (int(max(0, region[0])), int(max(0, region[1])), int(min(w, region[2])), int(min(h, region[3])))
        if rx2 - rx1 < 2 or ry2 - ry1 < 2:
            continue
        out[ry1:ry2, rx1:rx2] = _pixelate(out[ry1:ry2, rx1:rx2])
    return out


def _pixelate(roi: np.ndarray, blocks: int = 6) -> np.ndarray:
    """Coarse pixelation: irreversible, unlike a light blur."""
    h, w = roi.shape[:2]
    small = cv2.resize(roi, (max(1, w // max(1, w // blocks)), max(1, h // max(1, h // blocks))),
                       interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


def draw_box(frame: np.ndarray, bbox, color=(0, 0, 255)) -> np.ndarray:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = bbox
    cv2.rectangle(frame, (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h)), color, 2)
    return frame


@dataclass
class _PendingClip:
    path: str
    snapshot: str
    end_t: float
    bbox: Optional[tuple]
    frames: list = field(default_factory=list)


class ClipRecorder:
    """Per-camera ring buffer of (timestamp, frame, people) and clip writer."""

    def __init__(self, out_dir: str, camera_id: str, pre_s: float = 10.0, post_s: float = 10.0,
                 fps: float = 10.0, blur: bool = True, max_width: int = 960) -> None:
        self.out_dir = os.path.join(out_dir, camera_id)
        os.makedirs(self.out_dir, exist_ok=True)
        self.pre_s, self.post_s, self.fps, self.blur, self.max_width = pre_s, post_s, fps, blur, max_width
        self.buffer: deque = deque()
        self.pending: list[_PendingClip] = []
        self._last_push = 0.0
        self._ffmpeg = shutil.which("ffmpeg")

    def _prep(self, frame: np.ndarray, people) -> np.ndarray:
        if self.blur and people:
            frame = blur_faces(frame, people)
        if frame.shape[1] > self.max_width:
            scale = self.max_width / frame.shape[1]
            frame = cv2.resize(frame, (self.max_width, int(frame.shape[0] * scale)))
        return frame

    def push(self, t: float, frame: np.ndarray, people) -> None:
        # Store at most `fps` frames per second to bound memory.
        if t - self._last_push < 1.0 / self.fps:
            return
        self._last_push = t
        small = self._prep(frame, people)
        self.buffer.append((t, small))
        while self.buffer and t - self.buffer[0][0] > self.pre_s:
            self.buffer.popleft()
        done = []
        for clip in self.pending:
            clip.frames.append(small)
            if t >= clip.end_t:
                done.append(clip)
        for clip in done:
            self.pending.remove(clip)
            threading.Thread(target=self._write, args=(clip,), daemon=True).start()

    def start(self, t: float, bbox=None) -> tuple[str, str]:
        """Begin a clip for an event at time t. Returns (clip_path, snapshot_path) relative to the clips root."""
        name = f"{time.strftime('%Y%m%d-%H%M%S', time.localtime(t))}-{uuid.uuid4().hex[:8]}"
        path = os.path.join(self.out_dir, name + ".mp4")
        snap = os.path.join(self.out_dir, name + ".jpg")
        clip = _PendingClip(path=path, snapshot=snap, end_t=t + self.post_s, bbox=bbox,
                            frames=[f for _, f in self.buffer])
        if clip.frames:
            img = clip.frames[-1].copy()
            if bbox:
                draw_box(img, bbox)
            cv2.imwrite(snap, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        self.pending.append(clip)
        root = os.path.dirname(self.out_dir)
        return os.path.relpath(path, root), os.path.relpath(snap, root)

    def _write(self, clip: _PendingClip) -> None:
        if not clip.frames:
            return
        h, w = clip.frames[0].shape[:2]
        tmp = clip.path + ".tmp.avi"
        writer = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"MJPG"), self.fps, (w, h))
        for f in clip.frames:
            if f.shape[:2] != (h, w):
                f = cv2.resize(f, (w, h))
            writer.write(f)
        writer.release()
        try:
            if self._ffmpeg:
                # H.264 + faststart so browsers can play it directly
                subprocess.run(
                    [self._ffmpeg, "-y", "-loglevel", "error", "-i", tmp, "-c:v", "libx264", "-preset", "veryfast",
                     "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", clip.path + ".part"],
                    check=True, timeout=120,
                )
                # rename only when complete so the API never serves a half-written file
                os.replace(clip.path + ".part", clip.path)
                os.remove(tmp)
            else:
                os.replace(tmp, clip.path)
        except Exception:
            log.exception("clip encode failed, keeping MJPEG")
            os.replace(tmp, clip.path)
