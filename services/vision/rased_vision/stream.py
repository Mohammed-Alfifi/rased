"""Threaded video reader for RTSP / files with automatic reconnect.

Always returns the most recent frame, so a slow detector never builds a backlog
(stale frames are worse than skipped frames for live alerting).
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger(__name__)


class VideoStream:
    def __init__(self, url: str, loop_files: bool = True, reconnect_s: float = 3.0) -> None:
        self.url = url
        self.loop_files = loop_files
        self.reconnect_s = reconnect_s
        self._frame: Optional[np.ndarray] = None
        self._t = 0.0
        self._seq = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.connected = False
        self.last_frame_at = 0.0
        self.source_fps = 0.0
        self._is_file = os.path.exists(url)
        self._thread = threading.Thread(target=self._run, name=f"stream:{url}", daemon=True)

    def start(self) -> "VideoStream":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _open(self) -> cv2.VideoCapture:
        if self.url.startswith("rtsp://"):
            os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _run(self) -> None:
        while not self._stop.is_set():
            cap = self._open()
            if not cap.isOpened():
                self.connected = False
                log.warning("cannot open %s, retrying in %ss", self.url, self.reconnect_s)
                time.sleep(self.reconnect_s)
                continue
            self.connected = True
            fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            self.source_fps = fps if 1 <= fps <= 120 else 25.0
            frame_period = 1.0 / self.source_fps
            while not self._stop.is_set():
                start = time.time()
                ok, frame = cap.read()
                if not ok:
                    if self._is_file and self.loop_files:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    break
                now = time.time()
                with self._lock:
                    self._frame, self._t = frame, now
                    self._seq += 1
                self.last_frame_at = now
                if self._is_file:
                    # play files in real time so timings match a live camera
                    time.sleep(max(0.0, frame_period - (time.time() - start)))
            cap.release()
            self.connected = False
            if not self._stop.is_set():
                time.sleep(self.reconnect_s)

    def read(self, last_seq: int = -1) -> tuple[Optional[np.ndarray], float, int]:
        """Latest frame, its capture time and sequence number (unchanged seq = no new frame)."""
        with self._lock:
            if self._seq == last_seq:
                return None, self._t, self._seq
            return self._frame, self._t, self._seq
