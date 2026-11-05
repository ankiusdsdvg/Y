# One-image deployment: Node.js + npm dependencies + FFmpeg + yt-dlp.
# Render should use this Dockerfile from the project root (the folder containing src/).
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=10000 \
    YT_DLP_BIN=/usr/local/bin/yt-dlp \
    YT_DLP_JS_RUNTIME=node

# Install all system tools required by the API in the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       ffmpeg \
       python3 \
    && rm -rf /var/lib/apt/lists/*

# Install the latest standalone yt-dlp executable.
RUN curl --fail --location --retry 4 --retry-delay 2 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      --output /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version | head -n 1

WORKDIR /app

# Install Node dependencies during image build; no manual install on Render.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# IMPORTANT: build context must contain src/server.js at its root.
COPY . .
RUN test -f /src/server.js \
    && mkdir -p /app/data

EXPOSE 10000
CMD ["npm", "start"]
