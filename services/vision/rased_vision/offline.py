"""Run the full analysis on a video file without the API, frame by frame (not real time).

    python -m rased_vision.offline video.mp4 [--config cameras.yaml --camera cam1] [--fps 10] [--clips out/]

Prints each event as JSON. Used for quick checks and by training/evaluate_clips.py.
"""
from __future__ import annotations

import argparse
import json
from typing import Optional

import cv2

from .clips import ClipRecorder
from .config import Settings, load_file
from .detector import Detector
from .engine import CameraEngine
from .models import Camera, EVENT_TYPES, Event
from .tamper import TamperDetector


def analyse(path: str, camera: Camera, settings: Settings, fps: float = 10.0, clips_dir: Optional[str] = None,
            detector: Optional[Detector] = None, start_t: float = 1_000_000.0) -> list[dict]:
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, round(src_fps / fps))
    det = detector or Detector(settings.pose_model, settings.object_model, imgsz=settings.imgsz, device=settings.device)
    engine = CameraEngine(camera, fight_model=settings.fight_model)
    tamper = TamperDetector(hold_s=float(camera.params.get("tamper_s", 5.0)))
    rec = ClipRecorder(clips_dir, camera.id, blur=settings.blur_faces) if clips_dir else None
    out: list[dict] = []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            t = start_t + i / src_fps
            events: list[Event] = []
            reason = tamper.check(frame, t)
            if reason:
                events.append(Event(camera.id, "camera_tamper", EVENT_TYPES["camera_tamper"], 0.8, started_at=t, details={"reason": reason}))
            dets = det(frame)
            h, w = frame.shape[:2]
            events += engine.process(t, w, h, dets)
            if rec:
                rec.push(t, frame, [(d.bbox, d.keypoints) for d in dets if d.cls == "person"])
            for ev in events:
                if rec:
                    ev.clip_path, ev.snapshot_path = rec.start(t, ev.bbox)
                j = ev.to_json()
                j["videoSecond"] = round(i / src_fps, 2)
                out.append(j)
        i += 1
    cap.release()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--config", help="cameras YAML with zones (see deploy/demo/cameras.yaml)")
    ap.add_argument("--camera", help="camera id inside the config")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--clips", default=None, help="write event clips here")
    args = ap.parse_args()

    settings = Settings()
    camera = Camera(id=args.camera or "file", name=args.video, url=args.video)
    if args.config:
        cams = {c.id: c for c in load_file(args.config)}
        camera = cams[args.camera] if args.camera else next(iter(cams.values()))
    for ev in analyse(args.video, camera, settings, args.fps, args.clips):
        print(json.dumps(ev, ensure_ascii=False))


if __name__ == "__main__":
    main()
