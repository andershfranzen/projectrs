# syntax=docker/dockerfile:1.6
FROM oven/bun:1 AS builder
WORKDIR /app

# Cache deps layer — copy manifests first
COPY package.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY editor/package.json ./editor/
COPY website/package.json ./website/
RUN bun install

# Source
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/
COPY website/ ./website/
COPY scripts/ ./scripts/

# Vite bakes VITE_* env vars into the client bundle at build time. Surface
# them as build-args so docker-compose can pipe them through from the host
# .env file. RECAPTCHA_SECRET is runtime-only (server reads Bun.env), not here.
ARG VITE_RECAPTCHA_SITE_KEY=""
ENV VITE_RECAPTCHA_SITE_KEY=$VITE_RECAPTCHA_SITE_KEY

# Build browser surfaces
RUN cd client && bunx vite build
RUN cd website && bunx next build

FROM oven/bun:1
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    libegl1 \
    libgl1 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/website/dist ./website/dist

ENV NODE_ENV=production
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PROJECTRS_RUNTIME_DATA_DIR=/app/data
# Non-secret defaults for forum Discord emote sync. The bot token must be
# provided at runtime via docker-compose/.env, not baked into the image.
ENV DISCORD_GUILD_ID=1504534632799010816
ENV DISCORD_EMOJI_SYNC_INTERVAL_MS=900000
EXPOSE 4000
WORKDIR /app/data
CMD ["bun", "/app/server/src/main.ts"]
