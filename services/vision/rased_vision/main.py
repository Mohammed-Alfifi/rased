"""Entry point: keeps one worker per enabled camera, in step with the configuration."""
from __future__ import annotations

import logging
import signal
import sys
import time

from .client import ApiClient
from .config import Settings, cameras_from_dict, load_file
from .worker import CameraWorker

log = logging.getLogger("rased.vision")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings()
    client = ApiClient(settings.api_url, settings.service_key)
    workers: dict[str, CameraWorker] = {}
    stopping = False

    def _stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    while not stopping:
        if settings.config_file:
            cameras = load_file(settings.config_file)
        else:
            data = client.get_config()
            if data is None:
                time.sleep(5)
                continue
            cameras = cameras_from_dict(data)
            if "fightModel" in data and data["fightModel"]:
                settings.fight_model = data["fightModel"]

        wanted = {c.id: c for c in cameras if c.enabled}
        for cid in list(workers):
            if cid not in wanted:
                log.info("stopping camera %s", cid)
                workers.pop(cid).stop()
        for cid, cam in wanted.items():
            if cid in workers:
                workers[cid].update_camera(cam)
            else:
                log.info("starting camera %s (%s)", cid, cam.name)
                w = CameraWorker(cam, settings, client)
                w.start()
                workers[cid] = w

        for _ in range(60):  # re-read configuration every minute
            if stopping:
                break
            time.sleep(1)

    for w in workers.values():
        w.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
