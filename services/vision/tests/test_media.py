import os

import cv2
import numpy as np

from rased_vision.clips import ClipRecorder, blur_faces
from rased_vision.tamper import TamperDetector

from .helpers import standing_kp


def scene(seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.full((360, 640, 3), 120, np.uint8)
    for _ in range(40):
        x, y = rng.integers(0, 600), rng.integers(0, 330)
        cv2.rectangle(img, (int(x), int(y)), (int(x) + 30, int(y) + 20), tuple(int(c) for c in rng.integers(0, 255, 3)), -1)
    return img


def test_covered_camera():
    td = TamperDetector(hold_s=3, sample_every_s=1)
    for t in range(5):
        assert td.check(scene(), float(t)) is None
    black = np.zeros((360, 640, 3), np.uint8)
    results = [td.check(black, float(t)) for t in range(5, 12)]
    assert "covered" in results


def test_moved_camera():
    td = TamperDetector(hold_s=3, sample_every_s=1)
    for t in range(5):
        td.check(scene(0), float(t))
    results = [td.check(scene(99), float(t)) for t in range(5, 12)]
    assert "moved" in results


def test_steady_scene_is_fine():
    td = TamperDetector(hold_s=3, sample_every_s=1)
    assert all(td.check(scene(0), float(t)) is None for t in range(30))


def test_face_is_pixelated():
    img = scene()
    kp = standing_kp(0.5, 0.2, 0.6)
    out = blur_faces(img, [((0.45, 0.2, 0.55, 0.8), kp)])
    head = (slice(int(0.2 * 360), int(0.3 * 360)), slice(int(0.47 * 640), int(0.53 * 640)))
    assert not np.array_equal(out[head], img[head])
    # far from the head, nothing changes
    assert np.array_equal(out[300:, :100], img[300:, :100])


def test_clip_is_written(tmp_path):
    rec = ClipRecorder(str(tmp_path), "cam1", pre_s=1, post_s=1, fps=10)
    t = 0.0
    for _ in range(15):
        rec.push(t, scene(), [])
        t += 0.1
    clip, snap = rec.start(t)
    for _ in range(15):
        rec.push(t, scene(), [])
        t += 0.1
    import time
    for _ in range(100):
        if os.path.exists(os.path.join(tmp_path, clip)):
            break
        time.sleep(0.1)
    assert os.path.getsize(os.path.join(tmp_path, clip)) > 0
    assert os.path.exists(os.path.join(tmp_path, snap))
