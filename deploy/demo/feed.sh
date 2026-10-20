#!/usr/bin/env bash
# Publishes each clip in /samples as a looping RTSP stream: rtsp://mediamtx:8554/<camera-id>
# The demo seed (npm run seed:demo) creates cameras wing-a-1 ... visit-1 pointing at these paths.
set -u
CAMS=(wing-a-1 wing-a-2 wing-b-1 wing-b-2 yard-1 yard-2 dining-1 visit-1)
mapfile -t FILES < <(ls /samples/*.mp4 2>/dev/null)
if [ ${#FILES[@]} -eq 0 ]; then echo "no clips in samples/: run deploy/demo/make_sample.sh or add your own"; sleep infinity; fi
sleep 3
for i in "${!CAMS[@]}"; do
  f="${FILES[$(( i % ${#FILES[@]} ))]}"
  ( while true; do
      ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i "$f" -c:v libx264 -preset veryfast -tune zerolatency \
        -g 25 -an -f rtsp -rtsp_transport tcp "rtsp://mediamtx:8554/${CAMS[$i]}"
      sleep 2
    done ) &
done
wait
