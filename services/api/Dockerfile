# API + the built command centre, served from one origin.
# Build context: the services/ folder  ->  docker build -f services/api/Dockerfile services
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:20-alpine AS api
WORKDIR /api
COPY api/package*.json ./
RUN npm ci --no-audit --no-fund
COPY api/tsconfig*.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production TZ=Asia/Riyadh RASED_WEB_DIR=/app/web RASED_CLIPS_DIR=/data/clips
RUN apk add --no-cache tzdata && addgroup -S rased && adduser -S rased -G rased
WORKDIR /app
COPY --from=api /api/node_modules ./node_modules
COPY --from=api /api/dist ./dist
COPY api/db ./db
COPY api/package.json ./
COPY --from=web /web/dist ./web
USER rased
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/main.js"]
