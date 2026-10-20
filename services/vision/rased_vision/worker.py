"""Runs one camera end to end: stream -> detector -> engine -> clips -> API."""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from .client import ApiClient
from .clips import ClipRecorder
from .config import Settings
from .detector import Detector
from .engine import CameraEngine
from .models import Camera, EVENT_TYPES, Event
from .stream import VideoStream
from .tamper import TamperDetector

log = logging.getLogger(__name__)


class CameraWorker(threading.Thread):
    def __init__(self, camera: Camera, settings: Settings, client: Optional[ApiClient]) -> None:
        super().__init__(name=f"cam:{camera.id}", daemon=True)
        self.camera = camera
        self.settings = settings
        self.client = client
        self.engine = CameraEngine(camera, fight_model=settings.fight_model)
        self.stream = VideoStream(camera.url)
        self.tamper = TamperDetector(hold_s=float(camera.params.get("tamper_s", 5.0)))
        self.clips = ClipRecorder(settings.clips_dir, camera.id, blur=settings.blur_faces)
        self.detector: Optional[Detector] = None
        self._stop = threading.Event()
        self.processed_fps = 0.0
        self.last_latency_ms = 0.0
        self.status = "starting"
        self._offline_since: Optional[float] = None
        self._offline_alerted = False
        self.on_event = None  # optional callback (used by the offline runner)

    def update_camera(self, camera: Camera) -> None:
        if camera.url != self.camera.url:
            self.stream.stop()
            self.stream = VideoStream(camera.url).start()
        self.camera = camera
        self.engine.set_camera(camera)

    def stop(self) -> None:
        self._stop.set()
        self.stream.stop()

    def _emit(self, event: Event, frame_t: float) -> None:
        # the ring buffer already holds the seconds before the event; record a few after it
        clip, snap = self.clips.start(frame_t, event.bbox)
        event.clip_path, event.snapshot_path = clip, snap
        event.details.setdefault("detectionDelayMs", int((time.time() - frame_t) * 1000))
        payload = event.to_json()
        payload["detectedAt"] = time.time()
        log.info("event %s cam=%s zone=%s conf=%.2f", event.type, event.camera_id, event.zone_id, event.confidence)
        if self.client:
            self.client.event(payload)
        if self.on_event:
            self.on_event(payload)

    def _offline_check(self, now: float) -> None:
        if self.stream.connected and now - self.stream.last_frame_at < 10:
            self._offline_since, self._offline_alerted = None, False
            return
        self.status = "offline"
        self._offline_since = self._offline_since or now
        if not self._offline_alerted and now - self._offline_since >= float(self.camera.params.get("offline_s", 30)):
            self._offline_alerted = True
            ev = Event(self.camera.id, "camera_offline", EVENT_TYPES["camera_offline"], 1.0, started_at=self._offline_since,
                       details={"offlineSeconds": round(now - self._offline_since)})
            payload = ev.to_json()
            payload["detectedAt"] = now
            if self.client:
                self.client.event(payload)
            if self.on_event:
                self.on_event(payload)

    def run(self) -> None:
        self.detector = Detector(self.settings.pose_model, self.settings.object_model, imgsz=self.settings.imgsz,
                                 device=self.settings.device)
        self.stream.start()
        period = 1.0 / self.settings.target_fps
        seq = -1
        last_metrics = last_beat = time.time()
        frames, fps_t0 = 0, time.time()
        while not self._stop.is_set():
            loop_start = time.time()
            frame, frame_t, new_seq = self.stream.read(seq)
            if frame is None:
                self._offline_check(loop_start)
                time.sleep(0.05)
            else:
                seq = new_seq
                self.status = "online"
                self._offline_check(loop_start)
                reason = self.tamper.check(frame, frame_t)
                if reason:
                    self._emit(Event(self.camera.id, "camera_tamper", EVENT_TYPES["camera_tamper"], 0.8,
                                     started_at=frame_t, details={"reason": reason}), frame_t)
                dets = self.detector(frame)
                h, w = frame.shape[:2]
                events = self.engine.process(frame_t, w, h, dets)
                people = [(d.bbox, d.keypoints) for d in dets if d.cls == "person"]
                self.clips.push(frame_t, frame, people)
                for ev in events:
                    self._emit(ev, frame_t)
                self.last_latency_ms = (time.time() - frame_t) * 1000
                frames += 1

            now = time.time()
            if now - fps_t0 >= 5:
                self.processed_fps = frames / (now - fps_t0)
                frames, fps_t0 = 0, now
            if now - last_metrics >= self.settings.metrics_every_s:
                rows = self.engine.drain_metrics(now)
                if self.client:
                    self.client.metrics(rows)
                last_metrics = now
            if now - last_beat >= 10 and self.client:
                self.client.heartbeat({
                    "cameraId": self.camera.id,
                    "status": self.status,
                    "fps": round(self.processed_fps, 2),
                    "latencyMs": round(self.last_latency_ms),
                    "tracks": len(self.engine.persons),
                    "fightMode": self.engine.fight.mode,
                })
                last_beat = now
            time.sleep(max(0.0, period - (time.time() - loop_start)))
