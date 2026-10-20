FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=Asia/Riyadh
WORKDIR /app
COPY pyproject.toml ./
COPY rased_analytics ./rased_analytics
RUN pip install .
RUN useradd --system --uid 10001 rased
USER rased
CMD ["python", "-m", "rased_analytics.runner"]
