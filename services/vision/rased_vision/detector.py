"""YOLO detection + ByteTrack tracking.

One Detector instance per camera, because the tracker keeps per-stream state.
People come from the pose model (box + 17 keypoints); bags come from the object
model, run less often since they move slowly.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np

from .models import Detection

log = logging.getLogger(__name__)

OBJECT_CLASS_IDS = {24: "backpack", 26: "handbag", 28: "suitcase"}


def _load(path: str):
    """Load a model (.pt, .onnx or TensorRT .engine). Each camera gets its own instance
    because the tracker state lives inside the model object."""
    from ultralytics import YOLO

    return YOLO(path, task="pose" if "pose" in os.path.basename(path) else "detect")


class Detector:
    def __init__(self, pose_model: str, object_model: Optional[str], imgsz: int = 640,
                 conf: float = 0.35, object_every: int = 5, device: Optional[str] = None) -> None:
        self.pose = _load(pose_model)
        self.objects = _load(object_model) if object_model else None
        self.imgsz, self.conf, self.object_every, self.device = imgsz, conf, object_every, device
        self._n = 0
        self._last_objects: list[Detection] = []

    def __call__(self, frame: np.ndarray) -> list[Detection]:
        h, w = frame.shape[:2]
        out: list[Detection] = []
        res = self.pose.track(frame, persist=True, tracker="bytetrack.yaml", imgsz=self.imgsz,
                              conf=self.conf, classes=[0], verbose=False, device=self.device)[0]
        if res.boxes is not None and res.boxes.id is not None:
            boxes = res.boxes.xyxy.cpu().numpy()
            ids = res.boxes.id.int().cpu().numpy()
            confs = res.boxes.conf.cpu().numpy()
            kps = None
            if res.keypoints is not None and res.keypoints.data is not None:
                kps = res.keypoints.data.cpu().numpy()  # (n, 17, 3) pixels + conf
            for i, (b, tid, c) in enumerate(zip(boxes, ids, confs)):
                kp = None
                if kps is not None and i < len(kps):
                    kp = kps[i].astype(np.float32).copy()
                    kp[:, 0] /= w
                    kp[:, 1] /= h
                out.append(Detection(int(tid), "person", float(c), (b[0] / w, b[1] / h, b[2] / w, b[3] / h), kp))

        if self.objects is not None:
            if self._n % self.object_every == 0:
                self._last_objects = []
                r = self.objects.track(frame, persist=True, tracker="bytetrack.yaml", imgsz=self.imgsz,
                                       conf=0.3, classes=list(OBJECT_CLASS_IDS), verbose=False, device=self.device)[0]
                if r.boxes is not None and r.boxes.id is not None:
                    for b, tid, c, k in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.id.int().cpu().numpy(),
                                            r.boxes.conf.cpu().numpy(), r.boxes.cls.int().cpu().numpy()):
                        # offset object ids so they never collide with person ids
                        self._last_objects.append(Detection(100000 + int(tid), OBJECT_CLASS_IDS.get(int(k), "object"),
                                                            float(c), (b[0] / w, b[1] / h, b[2] / w, b[3] / h)))
            out.extend(self._last_objects)
        self._n += 1
        return out
