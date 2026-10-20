"""Fight / violence detection.

Two modes:
  * classifier: a trained pose-sequence model (ONNX) from training/, used when a
    model file is configured;
  * rules: a fallback based on two people being close while their arms move fast.
Both look at pairs of people who are near each other over ~2 seconds.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np

from ..models import Event, TrackState
from ..pose_features import WINDOW, TARGET_FPS, pair_window_features, resample, wrist_energy
from .base import Cooldown, FrameContext, Rule

log = logging.getLogger(__name__)


class FightClassifier:
    """Thin wrapper around the ONNX model exported by training/train_fight.py."""

    def __init__(self, path: str) -> None:
        import onnxruntime as ort

        providers = [p for p in ("TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider")
                     if p in ort.get_available_providers()]
        self.session = ort.InferenceSession(path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        log.info("fight classifier loaded from %s (providers=%s)", path, providers)

    def predict(self, feats: np.ndarray) -> float:
        out = self.session.run(None, {self.input_name: feats[None].astype(np.float32)})[0]
        return float(np.asarray(out).reshape(-1)[0])


class FightRule(Rule):
    name = "fight"

    def __init__(self, model_path: Optional[str] = None, cooldown_s: float = 120.0) -> None:
        self.cooldown = Cooldown(cooldown_s)
        self.classifier: Optional[FightClassifier] = None
        path = model_path or os.environ.get("RASED_FIGHT_MODEL")
        if path and os.path.exists(path):
            try:
                self.classifier = FightClassifier(path)
            except Exception:  # pragma: no cover - depends on runtime
                log.exception("could not load fight model, using rules")
        self._last_eval = 0.0
        self._hits: dict[tuple[int, int], int] = {}

    @property
    def mode(self) -> str:
        return "classifier" if self.classifier else "rules"

    def _close_pairs(self, ctx: FrameContext, people: list[TrackState], max_gap: float) -> list[tuple[TrackState, TrackState]]:
        pairs = []
        for i in range(len(people)):
            for j in range(i + 1, len(people)):
                a, b = people[i], people[j]
                ax, ay = (a.bbox[0] + a.bbox[2]) / 2 * ctx.aspect, a.bbox[3]
                bx, by = (b.bbox[0] + b.bbox[2]) / 2 * ctx.aspect, b.bbox[3]
                h = (a.height + b.height) / 2
                if ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 / h <= max_gap:
                    pairs.append((a, b))
        return pairs

    @staticmethod
    def _sequence(track: TrackState, end_t: float) -> list:
        times = [h[0] for h in track.history]
        kps = [h[4] for h in track.history]
        return resample(times, kps, end_t, WINDOW, TARGET_FPS)

    def update(self, ctx: FrameContext) -> list[Event]:
        if ctx.t - self._last_eval < 0.5:
            return []
        self._last_eval = ctx.t
        people = [p for p in ctx.persons.values() if p.last_seen == ctx.t and p.keypoints is not None]
        max_gap = float(ctx.param("fight_gap", 1.0))
        events: list[Event] = []
        live_pairs = set()
        for a, b in self._close_pairs(ctx, people, max_gap):
            key = tuple(sorted((a.track_id, b.track_id)))
            live_pairs.add(key)
            seq_a = self._sequence(a, ctx.t)
            seq_b = self._sequence(b, ctx.t)
            seen = sum(1 for x, y in zip(seq_a, seq_b) if x is not None and y is not None)
            if seen < WINDOW * 0.5:
                continue
            if self.classifier:
                score = self.classifier.predict(pair_window_features(seq_a, seq_b, ctx.aspect))
                hit = score >= float(ctx.param("fight_threshold", 0.6))
            else:
                ea, eb = wrist_energy(seq_a, ctx.aspect), wrist_energy(seq_b, ctx.aspect)
                hi, lo = max(ea, eb), min(ea, eb)
                score = float(np.clip((hi - 2.0) / 4.0 + 0.5, 0.0, 1.0))
                hit = hi >= float(ctx.param("fight_energy", 3.0)) and lo >= 1.0
            self._hits[key] = self._hits.get(key, 0) + 1 if hit else 0
            # two consecutive positive evaluations (about 1 second) before alerting
            if self._hits[key] >= 2 and self.cooldown.allow(key, ctx.t):
                x1 = min(a.bbox[0], b.bbox[0]); y1 = min(a.bbox[1], b.bbox[1])
                x2 = max(a.bbox[2], b.bbox[2]); y2 = max(a.bbox[3], b.bbox[3])
                zone_id = next(iter(a.zones | b.zones), None)
                events.append(
                    self.make_event(
                        ctx,
                        "fight",
                        confidence=score,
                        zone_id=zone_id,
                        track_ids=list(key),
                        bbox=(x1, y1, x2, y2),
                        started_at=ctx.t - WINDOW / TARGET_FPS,
                        details={"mode": self.mode},
                    )
                )
        for key in list(self._hits):
            if key not in live_pairs:
                del self._hits[key]
        return events
