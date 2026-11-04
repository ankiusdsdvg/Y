# YouTube Audio API Server

Node.js API tìm kiếm YouTube và phát **chỉ âm thanh MP3** qua server cho web player hoặc ESP32. Không tải video, không tạo luồng hình, không yêu cầu cấu hình cookies.

## Chạy local

Yêu cầu Node.js 20+, FFmpeg và yt-dlp đã cài, nằm trong PATH.

```bash
npm install
npm start
```

Mở `http://localhost:10000/health`.

## Chạy Docker

```bash
docker build -t youtube-audio-api .
docker run --rm -p 10000:10000 -v youtube-data:/app/data youtube-audio-api
```

## API

- `GET /api/youtube/search?q=lofi&limit=10&deviceId=esp32` — tìm bài hát/video trên YouTube.
- `GET /api/youtube/info?id=VIDEO_ID` — thông tin bài.
- `GET /api/youtube/stream?id=VIDEO_ID&type=audio` — lấy URL audio trực tiếp (có thể hết hạn).
- `GET /api/youtube/audio/VIDEO_ID.mp3` — chuyển audio sang MP3 128 kbps và stream qua server.
- `GET /api/youtube/watch?id=VIDEO_ID` — trả về URL audio-only tương thích route cũ; không có video.
- `GET /api/youtube/history?deviceId=esp32&limit=20`
- `POST /api/youtube/history` JSON: `{"deviceId":"esp32","videoId":"VIDEO_ID","title":"Tên bài","channel":"Kênh"}`
- `GET /api/youtube/favorites?deviceId=esp32`
- `POST /api/youtube/favorites` cùng JSON như history.
- `DELETE /api/youtube/favorites/VIDEO_ID?deviceId=esp32`

## Phát trên ESP32 / trình duyệt

Sau khi tìm kiếm, lấy `videoId` của kết quả rồi phát URL:

`http://YOUR_SERVER:10000/api/youtube/audio/VIDEO_ID.mp3`

Đầu ra là MP3 128 kbps, chỉ có tiếng. Không cần tải hoặc giải mã hình ảnh.

## Cookies và giới hạn

Server không đọc, không truyền và không yêu cầu file cookies. yt-dlp sẽ thử truy cập nội dung công khai mà không đăng nhập. Tuy nhiên, YouTube đôi khi vẫn yêu cầu xác minh bot, giới hạn khu vực hoặc đăng nhập đối với một số video; những trường hợp đó không thể đảm bảo phát được nếu không có quyền truy cập hợp lệ. Không có cách hợp pháp/đáng tin cậy để cam kết mọi video đều phát mà không xác thực.

Proxy MP3 dùng CPU và băng thông của server. Chỉ sử dụng nội dung bạn có quyền truy cập và phát lại; server không vượt DRM hoặc quyền truy cập.
