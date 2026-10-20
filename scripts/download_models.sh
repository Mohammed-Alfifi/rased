#!/usr/bin/env bash
# Downloads the YOLO11 pose and detection weights used by the vision service.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/services/vision/models"
mkdir -p "$DIR"
BASE=https://github.com/ultralytics/assets/releases/download/v8.3.0
for m in yolo11n-pose.pt yolo11n.pt; do
  [ -f "$DIR/$m" ] || curl -fSL -o "$DIR/$m" "$BASE/$m"
done
echo "models in $DIR"
