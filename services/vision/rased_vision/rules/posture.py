"""Person down (fall / lying on the floor) and prolonged inactivity."""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..models import Event, TrackState
from .base import Cooldown, FrameContext, Rule

# COCO keypoint indices
L_SH, R_SH, L_HIP, R_HIP, L_ANK, R_ANK = 5, 6, 11, 12, 15, 16


def lying_score(track: TrackState, aspect: float) -> float:
    """0..1 score that the person is horizontal.

    The torso angle (shoulders to hips) decides when the pose model sees it. The box
    shape is only a fallback, and is ignored when the box is cut by the frame edge
    (a person half out of view looks "wide" without lying down).
    """
    x1, y1, x2, y2 = track.bbox
    w_px = (x2 - x1) * aspect
    h_px = max(y2 - y1, 1e-6)
    ratio = w_px / h_px  # standing ~0.4, lying ~2+
    box_score = float(np.clip((ratio - 0.9) / 0.9, 0.0, 1.0))
    truncated = x1 < 0.03 or y1 < 0.03 or x2 > 0.97 or y2 > 0.97

    kp: Optional[np.ndarray] = track.keypoints
    pts = kp[[L_SH, R_SH, L_HIP, R_HIP]] if kp is not None else None
    if pts is None or (pts[:, 2] < 0.3).any():
        return 0.0 if truncated else box_score
    sh = pts[:2, :2].mean(axis=0)
    hip = pts[2:, :2].mean(axis=0)
    dx = (hip[0] - sh[0]) * aspect
    dy = hip[1] - sh[1]
    # angle of the torso from vertical: 0 = upright, 90 = horizontal
    angle = float(np.degrees(np.arctan2(abs(dx), abs(dy) + 1e-6)))
    torso_score = float(np.clip((angle - 45.0) / 30.0, 0.0, 1.0))
    return torso_score if truncated else 0.8 * torso_score + 0.2 * box_score


class PersonDownRule(Rule):
    name = "person_down"

    def __init__(self, cooldown_s: float = 300.0) -> None:
        self.cooldown = Cooldown(cooldown_s)
        self._down_since: dict[int, float] = {}

    def update(self, ctx: FrameContext) -> list[Event]:
        events: list[Event] = []
        hold = float(ctx.param("down_s", 3.0))
        threshold = float(ctx.param("down_threshold", 0.6))
        for tid, track in ctx.persons.items():
            if track.last_seen != ctx.t:
                continue
            score = lying_score(track, ctx.aspect)
            if score < threshold:
                self._down_since.pop(tid, None)
                continue
            since = self._down_since.setdefault(tid, ctx.t)
            if ctx.t - since < hold:
                continue
            zone_id = next(iter(track.zones), None)
            zone = ctx.zone(zone_id) if zone_id else None
            # Beds/bunks: a zone can disable this rule (people lie down there normally).
            if zone is not None and zone.params.get("allow_lying"):
                continue
            if self.cooldown.allow((tid,), ctx.t):
                events.append(
                    self.make_event(
                        ctx,
                        "person_down",
                        confidence=score,
                        zone_id=zone_id,
                        track_ids=[tid],
                        bbox=track.bbox,
                        started_at=since,
                        details={"downSeconds": round(ctx.t - since, 1)},
                    )
                )
        for tid in list(self._down_since):
            if tid not in ctx.persons:
                del self._down_since[tid]
        return events


class InactivityRule(Rule):
    """A person who has not moved for a long time. Off unless `inactivity_s` is set."""

    name = "prolonged_inactivity"

    def __init__(self, cooldown_s: float = 1800.0) -> None:
        self.cooldown = Cooldown(cooldown_s)

    def update(self, ctx: FrameContext) -> list[Event]:
        events: list[Event] = []
        for tid, track in ctx.persons.items():
            zone_id = next(iter(track.zones), None)
            zone = ctx.zone(zone_id) if zone_id else None
            limit = ctx.param("inactivity_s", None, zone)
            if not limit:
                continue
            limit = float(limit)
            if track.observed_for() < limit:
                continue
            if track.displacement(limit) > 0.3:
                continue
            if self.cooldown.allow((tid,), ctx.t):
                events.append(
                    self.make_event(
                        ctx,
                        "prolonged_inactivity",
                        confidence=0.7,
                        zone_id=zone_id,
                        track_ids=[tid],
                        bbox=track.bbox,
                        details={"stillSeconds": round(limit)},
                    )
                )
        return events
