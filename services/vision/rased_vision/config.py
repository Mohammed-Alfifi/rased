"""Service settings (environment) and camera/zone configuration (from the API or a YAML file)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

import yaml

from .geometry import polygon_from_json
from .models import Camera, Zone


@dataclass
class Settings:
    api_url: str = os.environ.get("RASED_API_URL", "http://localhost:3000")
    service_key: str = os.environ.get("RASED_SERVICE_KEY", "dev-service-key")
    clips_dir: str = os.environ.get("RASED_CLIPS_DIR", "./data/clips")
    pose_model: str = os.environ.get("RASED_POSE_MODEL", "models/yolo11n-pose.pt")
    object_model: Optional[str] = os.environ.get("RASED_OBJECT_MODEL", "models/yolo11n.pt") or None
    fight_model: Optional[str] = os.environ.get("RASED_FIGHT_MODEL")
    device: Optional[str] = os.environ.get("RASED_DEVICE") or None  # "0" for first GPU, "cpu"
    imgsz: int = int(os.environ.get("RASED_IMGSZ", "640"))
    target_fps: float = float(os.environ.get("RASED_TARGET_FPS", "10"))
    metrics_every_s: float = float(os.environ.get("RASED_METRICS_EVERY", "60"))
    config_file: Optional[str] = os.environ.get("RASED_CONFIG_FILE")  # offline mode without the API
    blur_faces: bool = os.environ.get("RASED_BLUR_FACES", "true").lower() != "false"
    extra: dict[str, Any] = field(default_factory=dict)


def cameras_from_dict(data: dict[str, Any]) -> list[Camera]:
    cams = []
    for c in data.get("cameras", []):
        zones = [
            Zone(
                id=str(z["id"]),
                camera_id=str(c["id"]),
                name=z.get("name", str(z["id"])),
                kind=z.get("kind", "general"),
                polygon=polygon_from_json(z["polygon"]),
                params=z.get("params") or {},
                restricted_hours=list(z.get("restrictedHours") or []),
            )
            for z in c.get("zones", [])
        ]
        cams.append(
            Camera(
                id=str(c["id"]),
                name=c.get("name", str(c["id"])),
                url=c["url"],
                zones=zones,
                enabled=c.get("enabled", True),
                params=c.get("params") or {},
            )
        )
    return cams


def load_file(path: str) -> list[Camera]:
    with open(path, encoding="utf-8") as fh:
        return cameras_from_dict(yaml.safe_load(fh))
