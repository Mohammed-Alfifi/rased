import numpy as np

from rased_vision.engine import CameraEngine
from rased_vision.geometry import point_in_polygon
from rased_vision.pose_features import FEATURE_DIM, WINDOW, pair_window_features, resample

from .helpers import (SQUARE_LEFT, SQUARE_RIGHT, bag, camera, lying_person, person, run, wiggle, zone)


def types(events):
    return [e.type for e in events]


def test_point_in_polygon():
    assert point_in_polygon((0.25, 0.5), SQUARE_LEFT)
    assert not point_in_polygon((0.75, 0.5), SQUARE_LEFT)


def test_restricted_zone_after_dwell():
    eng = CameraEngine(camera([zone("z1", "restricted", SQUARE_RIGHT)]))
    # walks from the left half into the right half and stays 3 seconds
    frames = [[person(1, 0.3 + 0.01 * i, 0.8)] for i in range(30)] + [[person(1, 0.7, 0.8)] for _ in range(30)]
    ev = run(eng, frames)
    assert types(ev) == ["restricted_zone"]
    assert ev[0].zone_id == "z1"


def test_restricted_zone_respects_hours():
    z = zone("z1", "restricted", SQUARE_RIGHT)
    z.restricted_hours = [22, 23, 0, 1, 2, 3, 4, 5]
    eng = CameraEngine(camera([z]))
    frames = [[person(1, 0.7, 0.8)] for _ in range(40)]
    assert run(eng, frames, hour=14) == []
    eng2 = CameraEngine(camera([z]))
    assert types(run(eng2, frames, hour=23)) == ["restricted_zone"]


def test_perimeter_is_critical():
    eng = CameraEngine(camera([zone("fence", "perimeter", SQUARE_RIGHT)]))
    ev = run(eng, [[person(1, 0.8, 0.5)] for _ in range(20)])
    assert types(ev) == ["perimeter_breach"]
    assert ev[0].severity == "critical"


def test_person_down():
    eng = CameraEngine(camera())
    frames = [[person(1, 0.5, 0.8)] for _ in range(10)] + [[lying_person(1, 0.5, 0.8)] for _ in range(40)]
    ev = run(eng, frames)
    assert types(ev) == ["person_down"]


def test_standing_person_is_not_down():
    eng = CameraEngine(camera())
    assert run(eng, [[person(1, 0.5, 0.8)] for _ in range(60)]) == []


def test_lying_allowed_in_bed_zone():
    eng = CameraEngine(camera([zone("beds", "general", SQUARE_LEFT, allow_lying=True)]))
    assert run(eng, [[lying_person(1, 0.25, 0.8)] for _ in range(60)]) == []


def test_gathering_once_with_cooldown():
    eng = CameraEngine(camera())
    group = [person(i, 0.4 + 0.02 * i, 0.8) for i in range(6)]
    ev = run(eng, [group for _ in range(150)])  # 15 seconds
    assert types(ev) == ["gathering"]
    assert ev[0].details["people"] == 6


def test_small_or_spread_groups_are_not_gatherings():
    eng = CameraEngine(camera())
    assert run(eng, [[person(i, 0.4 + 0.02 * i, 0.8) for i in range(3)] for _ in range(100)]) == []
    eng2 = CameraEngine(camera())
    spread = [person(i, 0.02 + 0.19 * i, 0.8) for i in range(6)]
    assert run(eng2, [spread for _ in range(100)]) == []


def test_running():
    eng = CameraEngine(camera())
    # 0.3-tall person moving 0.04 of the frame width per frame at 10 fps = ~2.4 heights per second
    ev = run(eng, [[person(1, 0.02 + 0.04 * i, 0.8)] for i in range(24)])
    assert "running" in types(ev)


def test_walking_is_not_running():
    eng = CameraEngine(camera())
    assert run(eng, [[person(1, 0.1 + 0.004 * i, 0.8)] for i in range(100)]) == []


def test_abandoned_object():
    eng = CameraEngine(camera(abandon_s=5))
    frames = [[bag(100001, 0.5, 0.9), person(1, 0.52, 0.9)] for _ in range(20)]  # owner nearby
    frames += [[bag(100001, 0.5, 0.9), person(1, 0.9, 0.9)] for _ in range(80)]  # owner walks away
    ev = run(eng, frames)
    assert types(ev) == ["abandoned_object"]


def test_bag_with_owner_is_fine():
    eng = CameraEngine(camera(abandon_s=5))
    frames = [[bag(100001, 0.5, 0.9), person(1, 0.52, 0.9)] for _ in range(100)]
    assert run(eng, frames) == []


def test_fight_rules_fallback():
    eng = CameraEngine(camera())
    frames = []
    for i in range(60):  # 6 seconds, fast arm movement, very close
        frames.append([person(1, 0.48, 0.8, wrist_dx=wiggle(i, 0.03), wrist_dy=wiggle(i + 1, 0.04)),
                       person(2, 0.52, 0.8, wrist_dx=wiggle(i + 1, 0.03), wrist_dy=wiggle(i, 0.04))])
    ev = run(eng, frames, fps=15)
    assert "fight" in types(ev)
    assert ev[types(ev).index("fight")].details["mode"] == "rules"


def test_calm_neighbours_are_not_a_fight():
    eng = CameraEngine(camera())
    frames = [[person(1, 0.48, 0.8), person(2, 0.52, 0.8)] for _ in range(90)]
    assert run(eng, frames, fps=15) == []


def test_metrics_rows():
    eng = CameraEngine(camera([zone("z1", "general", SQUARE_LEFT)]))
    run(eng, [[person(1, 0.25, 0.8), person(2, 0.75, 0.8)] for _ in range(20)])
    rows = eng.drain_metrics(2000.0)
    by_zone = {r["zoneId"]: r for r in rows}
    assert by_zone[None]["occupancyMax"] == 2
    assert by_zone["z1"]["occupancyMax"] == 1


def test_pose_features_shape():
    from .helpers import standing_kp
    seq = [standing_kp(0.5, 0.5, 0.3)] * WINDOW
    f = pair_window_features(seq, [None] * WINDOW)
    assert f.shape == (WINDOW, FEATURE_DIM)
    assert np.isfinite(f).all()


def test_resample_fills_gaps_with_none():
    times = [0.0, 0.5, 1.0]
    out = resample(times, ["a", "b", "c"], 1.0, n=16)
    assert out[-1] == "c"
    assert None in out


def test_person_cut_by_frame_edge_is_not_down():
    from rased_vision.models import Detection
    from .helpers import standing_kp
    eng = CameraEngine(camera())
    # upright person whose lower half is out of view: the box is wide, the torso is vertical
    det = Detection(1, "person", 0.9, (0.3, 0.6, 0.6, 1.0), standing_kp(0.45, 0.6, 0.7))
    assert run(eng, [[det] for _ in range(60)]) == []


def test_zone_alert_groups_people():
    eng = CameraEngine(camera([zone("fence", "perimeter", SQUARE_RIGHT)]))
    ev = run(eng, [[person(1, 0.7, 0.5), person(2, 0.8, 0.5), person(3, 0.9, 0.5)] for _ in range(20)])
    assert types(ev) == ["perimeter_breach"]
    assert ev[0].track_ids == [1, 2, 3]


def test_client_serializes_numpy():
    import json
    from rased_vision.client import dumps
    body = {"a": np.float32(0.5), "b": np.int64(3), "c": np.array([1.0, 2.0], dtype=np.float32)}
    assert json.loads(dumps(body)) == {"a": 0.5, "b": 3, "c": [1.0, 2.0]}


def test_fight_model_switches_at_run_time(tmp_path):
    from rased_vision.rules.fight import FightRule
    rule = FightRule()
    assert rule.mode == "rules"
    rule.set_model(str(tmp_path / "missing.onnx"))  # a missing file never breaks detection
    assert rule.mode == "rules"
    rule.set_model(None)
    assert rule.mode == "rules"
