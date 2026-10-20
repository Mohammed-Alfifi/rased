#!/usr/bin/env bash
# Builds a short test video with people in it from the public Ultralytics sample images.
# For realistic demos record your own staged clips (see docs/demo.md).
set -euo pipefail
OUT_DIR="${1:-$(dirname "$0")/../../samples}"
mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
curl -sSL -o "$TMP/zidane.jpg" https://github.com/ultralytics/assets/releases/download/v0.0.0/zidane.jpg
curl -sSL -o "$TMP/bus.jpg" https://github.com/ultralytics/assets/releases/download/v0.0.0/bus.jpg
# 20 s slow pan over each picture, 1280x720 at 25 fps
ffmpeg -y -loglevel error -loop 1 -i "$TMP/zidane.jpg" -vf "scale=1600:-2,zoompan=z='1.0':x='iw/2-(iw/zoom/2)+sin(on/40)*30':y='ih/2-(ih/zoom/2)':d=500:s=1280x720:fps=25" -t 20 -c:v libx264 -bf 0 -g 25 -pix_fmt yuv420p "$OUT_DIR/people-1.mp4"
ffmpeg -y -loglevel error -loop 1 -i "$TMP/bus.jpg" -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='1.05':x='iw/2-(iw/zoom/2)+sin(on/50)*20':y='ih/2-(ih/zoom/2)':d=500:s=1280x720:fps=25" -t 20 -c:v libx264 -bf 0 -g 25 -pix_fmt yuv420p "$OUT_DIR/people-2.mp4"
rm -rf "$TMP"
echo "wrote $OUT_DIR/people-1.mp4 and $OUT_DIR/people-2.mp4"
