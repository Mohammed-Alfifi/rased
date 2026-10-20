"""Camera tampering: covered lens, blurred / sprayed lens, camera moved."""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np


class TamperDetector:
    """Compares each sampled frame against a slowly updated reference.

    Returns a reason string ("covered", "blurred", "moved") once a condition has held
    for `hold_s` seconds, else None.
    """

    def __init__(self, hold_s: float = 5.0, sample_every_s: float = 1.0) -> None:
        self.hold_s = hold_s
        self.sample_every_s = sample_every_s
        self.reference: Optional[np.ndarray] = None
        self.ref_sharpness: Optional[float] = None
        self._last_sample = 0.0
        self._since: dict[str, float] = {}
        self._good_frames = 0

    @staticmethod
    def _small(frame: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        return cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)

    def check(self, frame: np.ndarray, t: float) -> Optional[str]:
        if t - self._last_sample < self.sample_every_s:
            return None
        self._last_sample = t
        small = self._small(frame)
        mean, std = float(small.mean()), float(small.std())
        sharp = float(cv2.Laplacian(small, cv2.CV_64F).var())

        reasons = set()
        if std < 6.0 or mean < 12.0:
            reasons.add("covered")
        elif self.ref_sharpness and sharp < self.ref_sharpness * 0.15:
            reasons.add("blurred")
        elif self.reference is not None:
            # Global change of view: compare edges, which survive lighting changes better.
            a = cv2.Canny(self.reference, 50, 150)
            b = cv2.Canny(small, 50, 150)
            union = np.count_nonzero(a | b)
            if union > 200:
                overlap = np.count_nonzero(cv2.dilate(a, None) & b) / max(np.count_nonzero(b), 1)
                if overlap < 0.25:
                    reasons.add("moved")

        if not reasons:
            self._since.clear()
            self._good_frames += 1
            if self.reference is None or self._good_frames % 30 == 0:
                # refresh reference slowly so day/night changes are absorbed
                self.reference = small.copy()
                self.ref_sharpness = sharp if self.ref_sharpness is None else 0.9 * self.ref_sharpness + 0.1 * sharp
            return None

        result = None
        for r in reasons:
            since = self._since.setdefault(r, t)
            if t - since >= self.hold_s:
                result = r
        for r in list(self._since):
            if r not in reasons:
                del self._since[r]
        return result
