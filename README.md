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
