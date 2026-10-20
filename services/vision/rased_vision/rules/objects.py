"""Objects left behind (bags, parcels) in visit or general areas."""
from __future__ import annotations

from ..models import Event
from .base import Cooldown, FrameContext, Rule

OBJECT_CLASSES = {"backpack", "handbag", "suitcase"}


class AbandonedObjectRule(Rule):
    name = "abandoned_object"

    def __init__(self, cooldown_s: float = 600.0) -> None:
        self.cooldown = Cooldown(cooldown_s)
        self._alone_since: dict[int, float] = {}

    def update(self, ctx: FrameContext) -> list[Event]:
        events: list[Event] = []
        wait = float(ctx.param("abandon_s", 60.0))
        radius = float(ctx.param("abandon_radius", 0.12))  # normalized frame units
        people = [p for p in ctx.persons.values() if p.last_seen == ctx.t]
        for oid, obj in ctx.objects.items():
            if obj.cls not in OBJECT_CLASSES or obj.last_seen != ctx.t:
                continue
            ox = (obj.bbox[0] + obj.bbox[2]) / 2
            oy = obj.bbox[3]
            near = any(
                ((((p.bbox[0] + p.bbox[2]) / 2 - ox) * ctx.aspect) ** 2 + (p.bbox[3] - oy) ** 2) ** 0.5 < radius
                for p in people
            )
            moved = obj.displacement(min(wait, 30.0)) > 0.5
            if near or moved:
                self._alone_since.pop(oid, None)
                continue
            since = self._alone_since.setdefault(oid, ctx.t)
            if ctx.t - since < wait:
                continue
            if self.cooldown.allow((oid,), ctx.t):
                zone_id = next(iter(obj.zones), None)
                events.append(
                    self.make_event(
                        ctx,
                        "abandoned_object",
                        confidence=0.7,
                        zone_id=zone_id,
                        track_ids=[oid],
                        bbox=obj.bbox,
                        started_at=since,
                        details={"object": obj.cls, "aloneSeconds": round(ctx.t - since)},
                    )
                )
        for oid in list(self._alone_since):
            if oid not in ctx.objects:
                del self._alone_since[oid]
        return events
