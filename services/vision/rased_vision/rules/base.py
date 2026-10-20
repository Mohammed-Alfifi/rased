from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

from ..models import Camera, Detection, Event, EVENT_TYPES, TrackState, Zone


@dataclass
class FrameContext:
    camera: Camera
    t: float
    width: int
    height: int
    local_hour: int
    persons: dict[int, TrackState]
    objects: dict[int, TrackState]
    detections: list[Detection]
    # zone id -> set of person track ids currently inside it
    zone_members: dict[str, set[int]] = field(default_factory=dict)

    @property
    def aspect(self) -> float:
        """Pixel width / pixel height, used to undo normalization distortion."""
        return self.width / max(self.height, 1)

    def zone(self, zone_id: str) -> Optional[Zone]:
        for z in self.camera.zones:
            if z.id == zone_id:
                return z
        return None

    def param(self, name: str, default: Any, zone: Optional[Zone] = None) -> Any:
        if zone is not None and name in zone.params:
            return zone.params[name]
        return self.camera.params.get(name, default)


class Rule:
    """A rule looks at the current frame context and returns new events."""

    name = "rule"

    def update(self, ctx: FrameContext) -> list[Event]:  # pragma: no cover - interface
        raise NotImplementedError

    @staticmethod
    def make_event(ctx: FrameContext, type_: str, confidence: float, **kwargs: Any) -> Event:
        return Event(
            camera_id=ctx.camera.id,
            type=type_,
            severity=kwargs.pop("severity", EVENT_TYPES[type_]),
            confidence=confidence,
            started_at=kwargs.pop("started_at", ctx.t),
            **kwargs,
        )


class Cooldown:
    """Suppresses repeats of the same alert (same type + key) inside a window."""

    def __init__(self, seconds: float = 60.0) -> None:
        self.seconds = seconds
        self._last: dict[tuple, float] = {}

    def allow(self, key: tuple, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        last = self._last.get(key)
        if last is not None and now - last < self.seconds:
            return False
        self._last[key] = now
        if len(self._last) > 5000:  # keep memory bounded
            cutoff = now - self.seconds
            self._last = {k: v for k, v in self._last.items() if v >= cutoff}
        return True
