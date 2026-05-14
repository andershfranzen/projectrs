# syntax=docker/dockerfile:1.6
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Cache deps layer — copy manifests first
COPY package.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY editor/package.json ./editor/
RUN bun install

# Source
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

# Build client → client/dist (also copies client/public into dist)
RUN cd client && bunx vite build

FROM oven/bun:1-alpine
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 4000
WORKDIR /app/data
CMD ["bun", "/app/server/src/main.ts"]
