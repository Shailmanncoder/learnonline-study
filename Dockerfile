# Debian Trixie/Bookworm GLIBC_2.38 compatible image
FROM node:22-slim

WORKDIR /app

COPY backend/package*.json ./backend/

WORKDIR /app/backend
# Build tools are needed for sqlite3 and removed in the same layer.
# Scripts must run here: onnxruntime-node fetches its native binary in
# postinstall, and skipping it leaves the embedder unable to start.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip \
    && find node_modules -type f -name "*.map" -delete 2>/dev/null || true \
    && find node_modules -type f -name "*.d.ts" -delete 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.npm /root/.cache /tmp/*

WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /app/backend/database

WORKDIR /app/backend

EXPOSE 5001

ENV PORT=5001
ENV NODE_ENV=production

CMD ["node", "server.js"]
