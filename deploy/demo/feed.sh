#!/usr/bin/env bash
# Publishes each clip in $SAMPLES as a looping RTSP stream: $RTSP/<camera-id>
# The demo seed (npm run seed:demo) creates cameras wing-a-1 ... visit-1 pointing at these paths.
# Clips are H.264 already, so they are passed through without re-encoding (cheap on CPU).
set -u
SAMPLES="${SAMPLES:-/samples}"
RTSP="${RTSP:-rtsp://mediamtx:8554}"
CAMS=(wing-a-1 wing-a-2 wing-b-1 wing-b-2 yard-1 yard-2 dining-1 visit-1)
mapfile -t FILES < <(ls "$SAMPLES"/*.mp4 2>/dev/null)
if [ ${#FILES[@]} -eq 0 ]; then echo "no clips in $SAMPLES: run scripts/fetch_samples.py or deploy/demo/make_sample.sh"; sleep infinity; fi
sleep 3
for i in "${!CAMS[@]}"; do
  f="${FILES[$(( i % ${#FILES[@]} ))]}"
  echo "${CAMS[$i]} <- $(basename "$f")"
  ( while true; do
      ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i "$f" -c copy -an -f rtsp -rtsp_transport tcp "$RTSP/${CAMS[$i]}"
      sleep 2
    done ) &
done
wait
