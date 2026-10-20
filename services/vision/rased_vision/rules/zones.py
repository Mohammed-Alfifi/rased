"""Restricted zones and perimeter (fence) zones."""
from __future__ import annotations

from ..models import Event
from .base import Cooldown, FrameContext, Rule


class ZoneIntrusionRule(Rule):
    name = "zone_intrusion"

    def __init__(self, cooldown_s: float = 120.0) -> None:
        self.cooldown = Cooldown(cooldown_s)

    def update(self, ctx: FrameContext) -> list[Event]:
        """One alert per zone per cooldown, listing everyone inside it at that moment."""
        events: list[Event] = []
        for zone in ctx.camera.zones:
            if zone.kind not in ("restricted", "perimeter"):
                continue
            if zone.kind == "restricted" and zone.restricted_hours and ctx.local_hour not in zone.restricted_hours:
                continue
            dwell = float(ctx.param("dwell_s", 2.0 if zone.kind == "restricted" else 1.0, zone))
            inside = []
            for tid in ctx.zone_members.get(zone.id, set()):
                track = ctx.persons.get(tid)
                if track is not None and ctx.t - track.zone_enter.get(zone.id, ctx.t) >= dwell:
                    inside.append(track)
            if not inside or not self.cooldown.allow((zone.id,), ctx.t):
                continue
            first = min(inside, key=lambda tr: tr.zone_enter.get(zone.id, ctx.t))
            entered = first.zone_enter.get(zone.id, ctx.t)
            type_ = "perimeter_breach" if zone.kind == "perimeter" else "restricted_zone"
            events.append(
                self.make_event(
                    ctx,
                    type_,
                    confidence=0.9,
                    zone_id=zone.id,
                    track_ids=sorted(tr.track_id for tr in inside),
                    bbox=(min(t.bbox[0] for t in inside), min(t.bbox[1] for t in inside),
                          max(t.bbox[2] for t in inside), max(t.bbox[3] for t in inside)),
                    started_at=entered,
                    details={"zone": zone.name, "people": len(inside), "dwellSeconds": round(ctx.t - entered, 1)},
                )
            )
        return events
