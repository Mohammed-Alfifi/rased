"""HTTP client for the Rased API. Buffers messages while the API is unreachable."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from typing import Any, Optional

import httpx
import numpy as np

log = logging.getLogger(__name__)


def _jsonable(o: Any) -> Any:
    """numpy scalars and arrays (from the models) to plain JSON types."""
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def dumps(body: Any) -> str:
    return json.dumps(body, default=_jsonable, ensure_ascii=False)


class ApiClient:
    def __init__(self, base_url: str, service_key: str, timeout: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(timeout=timeout, headers={"x-service-key": service_key})
        self._queue: deque = deque(maxlen=5000)
        self._lock = threading.Lock()

    def get_config(self) -> Optional[dict[str, Any]]:
        try:
            r = self.http.get(f"{self.base_url}/api/ingest/config")
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            log.warning("config fetch failed: %s", exc)
            return None

    def _post(self, path: str, body: Any) -> bool:
        try:
            r = self.http.post(f"{self.base_url}{path}", content=dumps(body).encode("utf-8"),
                               headers={"content-type": "application/json"})
            if r.status_code >= 500:
                return False
            if r.status_code >= 400:
                log.error("API rejected %s: %s %s", path, r.status_code, r.text[:300])
            return True  # 4xx is not retried
        except Exception as exc:
            log.warning("API unreachable (%s): %s", path, exc)
            return False

    def send(self, path: str, body: Any) -> None:
        """Send now; if it fails keep it and retry on the next flush."""
        with self._lock:
            self.flush()
            if not self._post(path, body):
                self._queue.append((path, body, time.time()))

    def flush(self) -> None:
        while self._queue:
            path, body, _ = self._queue[0]
            if not self._post(path, body):
                return
            self._queue.popleft()

    def event(self, payload: dict[str, Any]) -> None:
        self.send("/api/ingest/events", payload)

    def metrics(self, rows: list[dict[str, Any]]) -> None:
        if rows:
            self.send("/api/ingest/metrics", {"rows": rows})

    def heartbeat(self, payload: dict[str, Any]) -> None:
        # heartbeats are not queued: a stale heartbeat is useless
        self._post("/api/ingest/heartbeat", payload)
