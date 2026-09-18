# Debian, not Alpine: the local embedding model runs on onnxruntime-node,
# which ships glibc prebuilds only and cannot load under musl.
FROM node:20-slim

WORKDIR /app

COPY backend/package*.json ./backend/

WORKDIR /app/backend
# Build tools are needed for sqlite3 and removed in the same layer.
# Scripts must run here: onnxruntime-node fetches its native binary in
# postinstall, and skipping it leaves the embedder unable to start.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip \
    && npm rebuild sqlite3 --build-from-source \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.npm /root/.cache /tmp/*

# The embedding model, copied from the build context rather than fetched.
# Downloading it during the build needs network the builder does not always
# have, and leaving it to first use means a cold container answers WITHOUT
# retrieval until the download lands — seen as
# "[NCERT CONTEXT] search failed: fetch failed". This is the library's own
# default cache path, so no env var is involved.
COPY model-cache /app/backend/node_modules/@huggingface/transformers/.cache

WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /app/backend/database

WORKDIR /app/backend

EXPOSE 5001

ENV PORT=5001
ENV NODE_ENV=production

CMD ["node", "server.js"]
