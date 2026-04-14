# Stage 1: Build — install native deps with build tools
FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y cmake build-essential python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Strip node-llama-cpp CUDA/Vulkan binaries (CPU-only)
RUN rm -rf node_modules/@node-llama-cpp/linux-x64-cuda* \
    && rm -rf node_modules/@node-llama-cpp/linux-x64-vulkan*

# Stage 2: Runtime — slim image, no build tools
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y sqlite3 curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.mjs ./

RUN mkdir -p /data /home/user/.cache && chown -R node:node /data /app /home/user

ENV HOME=/home/user
ENV DATA_DIR=/data

USER node
EXPOSE 8000

CMD ["node", "/app/server.mjs"]
