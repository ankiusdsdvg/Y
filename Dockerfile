
FROM node:22-bookworm-slim

WORKDIR /app

# Install FFmpeg and Python
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy server
COPY server.js .

ENV NODE_ENV=production
ENV PORT=3000
ENV YTDLP_PATH=yt-dlp
ENV FFMPEG_PATH=ffmpeg

EXPOSE 3000

CMD ["node", "server.js"]
