# Rased all-in-one demo image (amd64 or arm64): a Hugging Face Space, or a single small server such as
# Oracle Cloud Always Free (deploy/oracle). Everything in one container: PostgreSQL, API + command centre,
# analytics, vision, training worker, and a local RTSP server that plays sample clips as if they were cameras.
# Data lives in /home/user: mount a volume there to keep it across restarts (deploy/oracle does).

FROM node:20-bookworm-slim AS web
WORKDIR /src/web
COPY services/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS api
WORKDIR /src/api
COPY services/api/package*.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/tsconfig*.json ./
COPY services/api/src ./src
RUN npm run build && npm prune --omit=dev

FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=Asia/Riyadh DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql postgresql-contrib ffmpeg libgl1 libglib2.0-0 curl ca-certificates tzdata procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=web /usr/local/bin/node /usr/local/bin/node

# Python services
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
COPY services/vision /app/vision
COPY services/analytics /app/analytics
RUN pip install "/app/vision[trainer]" /app/analytics supervisor

# API + command centre
COPY --from=api /src/api/node_modules /app/api/node_modules
COPY --from=api /src/api/dist /app/api/dist
COPY services/api/db /app/api/db
COPY --from=web /src/web/dist /app/web

# Model weights, the RTSP server and the sample clips are fetched at build time,
# so the running Space needs no internet access.
RUN mkdir -p /app/models \
 && curl -fsSL -o /app/models/yolo11n-pose.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt \
 && curl -fsSL -o /app/models/yolo11n.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt \
 && case "$(dpkg --print-architecture)" in arm64) MTX=arm64v8 ;; *) MTX=amd64 ;; esac \
 && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_${MTX}.tar.gz" | tar -xz -C /usr/local/bin mediamtx
COPY samples /app/samples
COPY scripts /app/scripts
COPY deploy/demo /app/demo
RUN python /app/scripts/fetch_samples.py --out /app/samples --seconds 20 || true \
 && bash /app/demo/make_sample.sh /app/samples || true \
 && ls -la /app/samples

COPY deploy/hf/supervisord.conf /app/supervisord.conf
COPY deploy/hf/start.sh deploy/hf/bootstrap.sh /app/
RUN chmod +x /app/start.sh /app/bootstrap.sh \
 && useradd -m -u 1000 user && chown -R user /app
USER user
ENV HOME=/home/user PORT=7860 \
    RASED_DATABASE_URL=postgresql://rased:rased@127.0.0.1:5432/rased \
    RASED_CLIPS_DIR=/home/user/data/clips RASED_TRAINING_DIR=/home/user/data/training RASED_MODELS_DIR=/home/user/data/models \
    RASED_WEB_DIR=/app/web RASED_POSE_MODEL=/app/models/yolo11n-pose.pt RASED_OBJECT_MODEL=/app/models/yolo11n.pt \
    RASED_TARGET_FPS=2 RASED_IMGSZ=480 RASED_API_URL=http://127.0.0.1:7860 YOLO_CONFIG_DIR=/tmp/ultralytics \
    NODE_ENV=production RASED_DEMO_LOGINS=1
EXPOSE 7860
CMD ["/app/start.sh"]
