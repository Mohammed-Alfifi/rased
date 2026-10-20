"""Plain data types shared by the vision pipeline."""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

# Severity levels, ordered. Kept in sync with the API (services/api/src/common/severity.ts).
SEVERITIES = ("low", "medium", "high", "critical")

# Event types and their default severity.
EVENT_TYPES: dict[str, str] = {
    "fight": "critical",
    "person_down": "critical",
    "perimeter_breach": "critical",
    "restricted_zone": "high",
    "gathering": "high",
    "camera_tamper": "high",
    "camera_offline": "high",
    "running": "medium",
    "abandoned_object": "medium",
    "prolonged_inactivity": "medium",
    "count_mismatch": "medium",
}


@dataclass
class Zone:
    id: str
    camera_id: str
    name: str
    kind: str  # general | restricted | perimeter | visit | count
    polygon: list[tuple[float, float]]
    # Optional per-zone thresholds (override the camera defaults).
    params: dict[str, Any] = field(default_factory=dict)
    # Hours (0-23, local) during which presence is NOT allowed for restricted zones; empty = always restricted.
    restricted_hours: list[int] = field(default_factory=list)


@dataclass
class Camera:
    id: str
    name: str
    url: str
    zones: list[Zone] = field(default_factory=list)
    enabled: bool = True
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class Detection:
    """One tracked object in one frame, coordinates normalized to 0..1."""
    track_id: int
    cls: str
    conf: float
    bbox: tuple[float, float, float, float]
    keypoints: Optional[np.ndarray] = None  # (17, 3): x, y (normalized), confidence


@dataclass
class TrackState:
    track_id: int
    cls: str
    first_seen: float
    last_seen: float
    history: deque = field(default_factory=lambda: deque(maxlen=90))  # (t, foot_x, foot_y, bbox, keypoints)
    zones: set[str] = field(default_factory=set)
    zone_enter: dict[str, float] = field(default_factory=dict)
    aspect: float = 16 / 9  # frame width / height in pixels, so x and y distances compare fairly

    def add(self, t: float, det: Detection) -> None:
        x1, y1, x2, y2 = det.bbox
        foot = ((x1 + x2) / 2.0, y2)
        self.history.append((t, foot[0], foot[1], det.bbox, det.keypoints))
        self.last_seen = t

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return self.history[-1][3]

    @property
    def keypoints(self) -> Optional[np.ndarray]:
        return self.history[-1][4]

    @property
    def height(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(y2 - y1, 1e-6)

    def speed(self, window_s: float = 1.0) -> float:
        """Foot speed in body-heights per second over the last `window_s` seconds.

        Normalizing by the person's own height makes the value comparable between
        people close to and far from the camera.
        """
        if len(self.history) < 2:
            return 0.0
        t_now = self.history[-1][0]
        old = None
        for item in self.history:
            if t_now - item[0] <= window_s:
                old = item
                break
        if old is None or t_now - old[0] <= 1e-6:
            return 0.0
        dx = (self.history[-1][1] - old[1]) * self.aspect
        dy = self.history[-1][2] - old[2]
        dist = (dx * dx + dy * dy) ** 0.5
        return dist / self.height / (t_now - old[0])

    def displacement(self, window_s: float) -> float:
        """Max distance (in body heights) moved from the position `window_s` seconds ago."""
        if len(self.history) < 2:
            return 0.0
        t_now = self.history[-1][0]
        pts = [(h[1], h[2]) for h in self.history if t_now - h[0] <= window_s]
        if len(pts) < 2:
            return 0.0
        x0, y0 = pts[0]
        best = max((((x - x0) * self.aspect) ** 2 + (y - y0) ** 2) ** 0.5 for x, y in pts)
        return best / self.height

    def observed_for(self) -> float:
        return self.last_seen - self.first_seen


@dataclass
class Event:
    camera_id: str
    type: str
    severity: str
    confidence: float
    started_at: float = field(default_factory=time.time)
    zone_id: Optional[str] = None
    track_ids: list[int] = field(default_factory=list)
    bbox: Optional[tuple[float, float, float, float]] = None
    details: dict[str, Any] = field(default_factory=dict)
    clip_path: Optional[str] = None
    snapshot_path: Optional[str] = None

    def to_json(self) -> dict[str, Any]:
        return {
            "cameraId": self.camera_id,
            "zoneId": self.zone_id,
            "type": self.type,
            "severity": self.severity,
            "confidence": round(float(self.confidence), 4),
            "startedAt": float(self.started_at),
            "trackIds": [int(t) for t in self.track_ids],
            "bbox": [round(float(v), 4) for v in self.bbox] if self.bbox else None,
            "details": self.details,
            "clipPath": self.clip_path,
            "snapshotPath": self.snapshot_path,
        }
