"""Gatherings (dense clusters of people) and running."""
from __future__ import annotations

from ..models import Event, TrackState
from .base import Cooldown, FrameContext, Rule


def clusters(tracks: list[TrackState], aspect: float, link: float) -> list[list[TrackState]]:
    """Single-linkage clustering of people by foot distance, measured in body heights."""
    n = len(tracks)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    feet = []
    for tr in tracks:
        x1, y1, x2, y2 = tr.bbox
        feet.append(((x1 + x2) / 2 * aspect, y2, max(y2 - y1, 1e-6)))
    for i in range(n):
        for j in range(i + 1, n):
            xi, yi, hi = feet[i]
            xj, yj, hj = feet[j]
            d = ((xi - xj) ** 2 + (yi - yj) ** 2) ** 0.5 / ((hi + hj) / 2)
            if d <= link:
                parent[find(i)] = find(j)
    groups: dict[int, list[TrackState]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(tracks[i])
    return list(groups.values())


class GatheringRule(Rule):
    name = "gathering"

    def __init__(self, cooldown_s: float = 300.0) -> None:
        self.cooldown = Cooldown(cooldown_s)
        self._since: dict[str, float] = {}
        self.last_max_cluster: dict[str, int] = {}

    def update(self, ctx: FrameContext) -> list[Event]:
        events: list[Event] = []
        scopes: list[tuple[str | None, list[TrackState]]] = []
        visible = [t for t in ctx.persons.values() if t.last_seen == ctx.t]
        # The whole frame is one scope only when the camera has no zones; otherwise each
        # zone is judged on its own so one group never raises two alerts.
        if not ctx.camera.zones:
            scopes.append((None, visible))
        for zone in ctx.camera.zones:
            members = [ctx.persons[i] for i in ctx.zone_members.get(zone.id, set()) if i in ctx.persons]
            scopes.append((zone.id, members))

        for zone_id, people in scopes:
            zone = ctx.zone(zone_id) if zone_id else None
            min_people = int(ctx.param("gathering_min", 5, zone))
            link = float(ctx.param("gathering_link", 1.0, zone))  # max gap between neighbours, in body heights
            hold = float(ctx.param("gathering_s", 5.0, zone))
            key = zone_id or "__camera__"
            biggest = max((len(c) for c in clusters(people, ctx.aspect, link)), default=0)
            self.last_max_cluster[key] = biggest
            if biggest < min_people:
                self._since.pop(key, None)
                continue
            since = self._since.setdefault(key, ctx.t)
            if ctx.t - since < hold:
                continue
            if self.cooldown.allow((key,), ctx.t):
                group = max(clusters(people, ctx.aspect, link), key=len)
                xs1 = min(t.bbox[0] for t in group)
                ys1 = min(t.bbox[1] for t in group)
                xs2 = max(t.bbox[2] for t in group)
                ys2 = max(t.bbox[3] for t in group)
                events.append(
                    self.make_event(
                        ctx,
                        "gathering",
                        confidence=min(1.0, 0.6 + 0.05 * (biggest - min_people)),
                        zone_id=zone_id,
                        track_ids=[t.track_id for t in group],
                        bbox=(xs1, ys1, xs2, ys2),
                        started_at=since,
                        details={"people": biggest},
                    )
                )
        return events


class RunningRule(Rule):
    name = "running"

    def __init__(self, cooldown_s: float = 60.0) -> None:
        self.cooldown = Cooldown(cooldown_s)
        self._fast_since: dict[int, float] = {}
        self.running_now = 0

    def update(self, ctx: FrameContext) -> list[Event]:
        threshold = float(ctx.param("running_speed", 1.6))  # body heights per second; walking is ~0.8
        hold = float(ctx.param("running_s", 1.0))
        runners = []
        for tid, track in ctx.persons.items():
            if track.last_seen != ctx.t or track.observed_for() < 0.5:
                self._fast_since.pop(tid, None)
                continue
            if track.speed(0.7) >= threshold:
                since = self._fast_since.setdefault(tid, ctx.t)
                if ctx.t - since >= hold:
                    runners.append(track)
            else:
                self._fast_since.pop(tid, None)
        self.running_now = len(runners)
        if not runners:
            return []
        key = tuple(sorted(t.track_id for t in runners)) if len(runners) >= 3 else (runners[0].track_id,)
        if not self.cooldown.allow(key, ctx.t):
            return []
        many = len(runners) >= 3
        lead = runners[0]
        return [
            self.make_event(
                ctx,
                "running",
                confidence=0.75,
                severity="high" if many else "medium",
                zone_id=next(iter(lead.zones), None),
                track_ids=[t.track_id for t in runners],
                bbox=lead.bbox,
                details={"runners": len(runners)},
            )
        ]
