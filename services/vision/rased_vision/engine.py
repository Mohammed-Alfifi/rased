"""Per-camera analysis core: tracks, zones, rules and per-minute metrics.

It takes detections (already tracked) and returns events. It does no I/O, which
keeps it fast to test with synthetic tracks.
"""
from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, Optional

from .geometry import point_in_polygon
from .models import Camera, Detection, Event, TrackState
from .rules.base import FrameContext, Rule
from .rules.crowd import GatheringRule, RunningRule
from .rules.fight import FightRule
from .rules.objects import AbandonedObjectRule
from .rules.posture import InactivityRule, PersonDownRule
from .rules.zones import ZoneIntrusionRule

TRACK_TTL_S = 3.0
RUNNING_SPEED = 1.6  # body heights per second (about 2.7 m/s for a 1.7 m person)


class CameraEngine:
    def __init__(self, camera: Camera, fight_model: Optional[str] = None,
                 rules: Optional[list[Rule]] = None) -> None:
        self.camera = camera
        self.persons: dict[int, TrackState] = {}
        self.objects: dict[int, TrackState] = {}
        self.gathering = GatheringRule()
        self.running = RunningRule()
        self.fight = FightRule(model_path=fight_model)
        self.rules: list[Rule] = rules if rules is not None else [
            ZoneIntrusionRule(),
            PersonDownRule(),
            InactivityRule(),
            self.gathering,
            self.running,
            AbandonedObjectRule(),
            self.fight,
        ]
        self._metrics = _MetricsWindow()

    def set_camera(self, camera: Camera) -> None:
        """Apply a configuration change (zones edited in the command centre) without losing tracks."""
        self.camera = camera
        valid = {z.id for z in camera.zones}
        for tr in list(self.persons.values()) + list(self.objects.values()):
            tr.zones &= valid
            tr.zone_enter = {k: v for k, v in tr.zone_enter.items() if k in valid}

    def process(self, t: float, width: int, height: int, detections: list[Detection],
                local_hour: Optional[int] = None) -> list[Event]:
        if local_hour is None:
            local_hour = time.localtime(t).tm_hour
        for det in detections:
            store = self.persons if det.cls == "person" else self.objects
            tr = store.get(det.track_id)
            if tr is None:
                tr = store[det.track_id] = TrackState(det.track_id, det.cls, t, t, aspect=width / max(height, 1))
            tr.add(t, det)
        for store in (self.persons, self.objects):
            for tid in [k for k, v in store.items() if t - v.last_seen > TRACK_TTL_S]:
                del store[tid]

        zone_members: dict[str, set[int]] = defaultdict(set)
        for store in (self.persons, self.objects):
            for tr in store.values():
                if tr.last_seen != t:
                    continue
                x1, y1, x2, y2 = tr.bbox
                foot = ((x1 + x2) / 2, y2)
                now_in = {z.id for z in self.camera.zones if point_in_polygon(foot, z.polygon)}
                for zid in now_in - tr.zones:
                    tr.zone_enter[zid] = t
                for zid in tr.zones - now_in:
                    tr.zone_enter.pop(zid, None)
                tr.zones = now_in
                if tr.cls == "person":
                    for zid in now_in:
                        zone_members[zid].add(tr.track_id)

        ctx = FrameContext(
            camera=self.camera, t=t, width=width, height=height, local_hour=local_hour,
            persons=self.persons, objects=self.objects, detections=detections, zone_members=dict(zone_members),
        )
        events: list[Event] = []
        for rule in self.rules:
            events.extend(rule.update(ctx))

        self._metrics.add(ctx, self.gathering.last_max_cluster, self.running.running_now, events)
        return events

    def drain_metrics(self, now: float) -> list[dict[str, Any]]:
        return self._metrics.drain(self.camera, now)


class _MetricsWindow:
    """Accumulates samples between flushes; one row per zone plus one for the whole camera."""

    def __init__(self) -> None:
        self.reset(time.time())

    def reset(self, t: float) -> None:
        self.start = t
        self.samples: dict[Optional[str], list[tuple[int, float, int, int]]] = defaultdict(list)
        self.events: dict[Optional[str], int] = defaultdict(int)

    def add(self, ctx: FrameContext, clusters: dict[str, int], runners: int, events: list[Event]) -> None:
        visible = [p for p in ctx.persons.values() if p.last_seen == ctx.t]
        speed = sum(p.speed(1.0) for p in visible) / len(visible) if visible else 0.0
        cam_cluster = max(clusters.values(), default=0)
        self.samples[None].append((len(visible), speed, cam_cluster, runners))
        for zone in ctx.camera.zones:
            members = [ctx.persons[i] for i in ctx.zone_members.get(zone.id, set()) if i in ctx.persons]
            zspeed = sum(p.speed(1.0) for p in members) / len(members) if members else 0.0
            zrun = sum(1 for p in members if p.speed(0.7) >= RUNNING_SPEED)
            self.samples[zone.id].append((len(members), zspeed, clusters.get(zone.id, 0), zrun))
        for e in events:
            self.events[e.zone_id] += 1
            if e.zone_id is not None:
                self.events[None] += 1

    def drain(self, camera: Camera, now: float) -> list[dict[str, Any]]:
        rows = []
        for zone_id, s in self.samples.items():
            if not s:
                continue
            n = len(s)
            rows.append({
                "cameraId": camera.id,
                "zoneId": zone_id,
                "periodStart": self.start,
                "periodEnd": now,
                "samples": n,
                "occupancyAvg": round(sum(x[0] for x in s) / n, 3),
                "occupancyMax": max(x[0] for x in s),
                "motionAvg": round(sum(x[1] for x in s) / n, 4),
                "clusterMax": max(x[2] for x in s),
                "runnersMax": max(x[3] for x in s),
                "events": self.events.get(zone_id, 0),
            })
        self.reset(now)
        return rows
