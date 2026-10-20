# Rased vision service.
#   CPU build (default):  docker build -t rased-vision services/vision
#   GPU build:            docker build -t rased-vision:gpu --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04 --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124 services/vision
ARG BASE=python:3.11-slim
FROM ${BASE}

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=Asia/Riyadh

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 curl ca-certificates tzdata \
      $(command -v python3 >/dev/null || echo python3 python3-pip) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN python3 -m pip install --upgrade pip \
 && python3 -m pip install --index-url ${TORCH_INDEX} torch torchvision
COPY pyproject.toml ./
COPY rased_vision ./rased_vision
COPY rased_trainer ./rased_trainer
RUN python3 -m pip install ".[trainer]"

# Model weights are baked into the image so the facility can run offline.
RUN mkdir -p models \
 && curl -fsSL -o models/yolo11n-pose.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt \
 && curl -fsSL -o models/yolo11n.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt

RUN useradd --system --uid 10001 rased && mkdir -p /data/clips /data/models /data/training && chown -R rased /app /data
USER rased
ENV RASED_CLIPS_DIR=/data/clips YOLO_CONFIG_DIR=/tmp/ultralytics
CMD ["python3", "-m", "rased_vision.main"]
