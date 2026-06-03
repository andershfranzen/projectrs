# syntax=docker/dockerfile:1.6
FROM oven/bun:1-alpine AS builder
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

FROM oven/bun:1-alpine
WORKDIR /app
RUN apk add --no-cache chromium
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
EXPOSE 4000
WORKDIR /app/data
CMD ["bun", "/app/server/src/main.ts"]
