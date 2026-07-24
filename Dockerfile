# syntax=docker/dockerfile:1
#
# Public hosting server (multi-session). One container runs many tenant sessions.
# Config via env: HUB_URL, CONNECTOR_DATA_DIR (mount a volume), PORT.

# ---------- build stage ----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    CONNECTOR_DATA_DIR=/data \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Per-tenant state (meta.json + wa_session/ per session) — mount a volume here.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/server/main.js"]
