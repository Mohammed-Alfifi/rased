"""Synthetic people for rule tests: no model, no video."""
from __future__ import annotations

import math

import numpy as np

from rased_vision.models import Camera, Detection, Zone


def standing_kp(cx: float, top: float, h: float, wrist_dx: float = 0.0, wrist_dy: float = 0.0) -> np.ndarray:
    """17 COCO keypoints for an upright person whose box is `h` tall starting at `top`."""
    kp = np.zeros((17, 3), dtype=np.float32)
    w = h * 0.25
    pts = {
        0: (cx, top + 0.08 * h), 1: (cx - 0.03 * w, top + 0.06 * h), 2: (cx + 0.03 * w, top + 0.06 * h),
        3: (cx - 0.08 * w, top + 0.07 * h), 4: (cx + 0.08 * w, top + 0.07 * h),
        5: (cx - 0.3 * w, top + 0.2 * h), 6: (cx + 0.3 * w, top + 0.2 * h),
        7: (cx - 0.35 * w, top + 0.35 * h), 8: (cx + 0.35 * w, top + 0.35 * h),
        9: (cx - 0.35 * w + wrist_dx, top + 0.48 * h + wrist_dy), 10: (cx + 0.35 * w - wrist_dx, top + 0.48 * h - wrist_dy),
        11: (cx - 0.2 * w, top + 0.55 * h), 12: (cx + 0.2 * w, top + 0.55 * h),
        13: (cx - 0.2 * w, top + 0.77 * h), 14: (cx + 0.2 * w, top + 0.77 * h),
        15: (cx - 0.2 * w, top + h), 16: (cx + 0.2 * w, top + h),
    }
    for i, (x, y) in pts.items():
        kp[i] = (x, y, 0.9)
    return kp


def lying_kp(cx: float, y: float, length: float) -> np.ndarray:
    """A person lying horizontally: head on the left, feet on the right."""
    kp = np.zeros((17, 3), dtype=np.float32)
    x0 = cx - length / 2
    xs = {0: 0.02, 1: 0.02, 2: 0.02, 3: 0.03, 4: 0.03, 5: 0.15, 6: 0.15, 7: 0.3, 8: 0.3, 9: 0.42, 10: 0.42,
          11: 0.5, 12: 0.5, 13: 0.72, 14: 0.72, 15: 0.98, 16: 0.98}
    for i, fx in xs.items():
        dy = 0.01 if i % 2 else -0.01
        kp[i] = (x0 + fx * length, y + dy, 0.9)
    return kp


def person(tid: int, cx: float, foot_y: float, h: float = 0.3, **kw) -> Detection:
    w = h * 0.25 / (16 / 9)  # normalized width for a 16:9 frame
    bbox = (cx - w / 2, foot_y - h, cx + w / 2, foot_y)
    return Detection(tid, "person", 0.9, bbox, standing_kp(cx, foot_y - h, h, **kw))


def lying_person(tid: int, cx: float, y: float, length: float = 0.18) -> Detection:
    bbox = (cx - length / 2, y - 0.03, cx + length / 2, y + 0.03)
    return Detection(tid, "person", 0.9, bbox, lying_kp(cx, y, length))


def bag(tid: int, cx: float, y: float) -> Detection:
    return Detection(tid, "backpack", 0.8, (cx - 0.015, y - 0.03, cx + 0.015, y))


def camera(zones: list[Zone] | None = None, **params) -> Camera:
    return Camera(id="cam1", name="Test", url="test.mp4", zones=zones or [], params=params)


def zone(id_: str, kind: str, poly, **params) -> Zone:
    return Zone(id=id_, camera_id="cam1", name=id_, kind=kind, polygon=poly, params=params)


SQUARE_LEFT = [(0.0, 0.0), (0.5, 0.0), (0.5, 1.0), (0.0, 1.0)]
SQUARE_RIGHT = [(0.5, 0.0), (1.0, 0.0), (1.0, 1.0), (0.5, 1.0)]


def run(engine, frames, fps: float = 10.0, t0: float = 1000.0, hour: int = 12):
    """Feed a list of detection lists to the engine and collect all events."""
    events = []
    for i, dets in enumerate(frames):
        events += engine.process(t0 + i / fps, 1920, 1080, dets, local_hour=hour)
    return events


def wiggle(i: int, amp: float, period: int = 3) -> float:
    return amp * math.sin(2 * math.pi * i / period)
