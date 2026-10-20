#!/usr/bin/env bash
# One-shot: once the API is up, load the demo data and compute the first scores.
set -uo pipefail
for _ in $(seq 1 120); do
  curl -fs "http://127.0.0.1:${PORT}/api/health" >/dev/null && break
  sleep 2
done
cd /app/api && node dist/scripts/seed-demo.js --rtsp-base rtsp://127.0.0.1:8554
python -m rased_analytics.runner --once
echo "demo ready"
