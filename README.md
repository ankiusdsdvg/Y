# YouTube API Server

Node.js API cho web player / ESP32. Có tìm kiếm, metadata, URL stream, proxy audio MP3, lịch sử và yêu thích.

## Chạy local

Yêu cầu Node.js 20+, FFmpeg và yt-dlp đã cài, nằm trong PATH.

```bash
npm install
npm start
```

Mở `http://localhost:10000/health`.

## Chạy Docker

```bash
docker build -t youtube-api .
docker run --rm -p 10000:10000 -v youtube-data:/app/data youtube-api
```

## API

- `GET /api/youtube/search?q=lofi&limit=10&deviceId=esp32`
- `GET /api/youtube/info?id=VIDEO_ID`
- `GET /api/youtube/stream?id=VIDEO_ID&type=audio`
- `GET /api/youtube/stream?id=VIDEO_ID&type=video`
- `GET /api/youtube/audio/VIDEO_ID.mp3` — chuyển âm thanh sang MP3 128 kbps và stream qua server
- `GET /api/youtube/history?deviceId=esp32&limit=20`
- `POST /api/youtube/history` JSON: `{"deviceId":"esp32","videoId":"VIDEO_ID","title":"Tên video","channel":"Kênh"}`
- `GET /api/youtube/favorites?deviceId=esp32`
- `POST /api/youtube/favorites` cùng JSON như history
- `DELETE /api/youtube/favorites/VIDEO_ID?deviceId=esp32`

## Gọi thử

```bash
curl "http://localhost:10000/api/youtube/search?q=nhac%20lofi&limit=5"
curl "http://localhost:10000/api/youtube/stream?id=VIDEO_ID&type=audio"
```

ESP32 phát MP3 có thể mở URL:
`http://YOUR_SERVER:10000/api/youtube/audio/VIDEO_ID.mp3`

## Deploy Render

Push thư mục này lên GitHub, tạo Web Service từ repository, chọn Docker (Render nhận `Dockerfile`/`render.yaml`). Dữ liệu SQLite trên filesystem gói Free có thể mất khi service restart/redeploy; muốn lưu bền vững hãy dùng persistent disk hoặc PostgreSQL.

## Ghi chú

- YouTube có thể thay đổi cơ chế truy cập; cập nhật yt-dlp khi phát sinh lỗi.
- Một số video bị giới hạn khu vực, yêu cầu đăng nhập, riêng tư hoặc chặn nhúng sẽ không phát được.
- URL lấy từ `/stream` có thể hết hạn nhanh; gọi API lại khi cần.
- Proxy MP3 dùng CPU và băng thông của server. Không nên chạy nhiều luồng đồng thời trên gói miễn phí.
- Chỉ sử dụng với nội dung bạn có quyền truy cập và phát lại. Server không vượt DRM hay quyền truy cập.

## Phát YouTube realtime kiểu IPTV (hình + tiếng riêng)

Pipeline dùng `yt-dlp` lấy URL media, sau đó FFmpeg giải mã đồng thời:

- Hình: MJPEG multipart, mặc định 320×180, 10 FPS.
- Tiếng: PCM signed 16-bit little-endian, mono, 16 kHz, chia khung 20 ms.

### Trình tự gọi

1. Bắt đầu giải mã video:
   `GET /api/youtube/watch?id=VIDEO_ID`
2. Đọc hình liên tục:
   `GET /api/youtube/video.mjpg`
3. Đọc âm thanh PCM liên tục:
   `GET /api/youtube/audio.pcm`
4. Dừng:
   `POST /api/youtube/stop`
5. Kiểm tra:
   `GET /api/youtube/playback/status`

Ví dụ bắt đầu:

```bash
curl "http://localhost:10000/api/youtube/watch?id=VIDEO_ID"
```

Response trả về hai endpoint `video` và `audio`. Client hiển thị MJPEG như luồng camera/IPTV; client âm thanh phải đọc PCM 16-bit little-endian ở 16000 Hz, mono và phát qua audio output. PCM thô không phải MP3/WAV nên thẻ HTML `<audio>` không phát trực tiếp được nếu không có bộ nhận/giải mã PCM ở client.

Các biến môi trường tùy chỉnh: `PLAYBACK_WIDTH`, `PLAYBACK_HEIGHT`, `PLAYBACK_FPS`, `PLAYBACK_JPEG_QUALITY`, `PLAYBACK_AUDIO_RATE`.

**Lưu ý:** Đây là một pipeline phát chung trên server: tại một thời điểm chỉ chọn được một video; các client kết nối cùng xem video đó. Video và audio được truyền trên hai kết nối riêng, vì vậy ứng dụng client cần ghép thời gian phát hai luồng. Chất lượng/độ trễ phụ thuộc nguồn YouTube, CPU, mạng và khả năng xử lý của client.
