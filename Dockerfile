FROM node:22-bookworm

# System deps for QMD (sqlite3 for FTS5, cmake/python3 for node-llama-cpp native build)
RUN apt-get update && apt-get install -y curl sqlite3 cmake build-essential python3 && rm -rf /var/lib/apt/lists/*

# App code + dependencies
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

# Data + home directory for per-user workspace + indexes + model cache
RUN mkdir -p /data /home/user/.cache && chown -R node:node /data /app /home/user

ENV HOME=/home/user
ENV DATA_DIR=/data

USER node
EXPOSE 8000

CMD ["node", "/app/server.mjs"]
