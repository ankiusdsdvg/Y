# SoundCloud Audio API (không cần cookies)

API Node.js 20 dùng `yt-dlp` để tìm kiếm/lấy track SoundCloud công khai và FFmpeg để chuyển luồng âm thanh sang MP3. Không có chức năng tải video, không yêu cầu file cookies hay đăng nhập.

## Chạy bằng Docker

```bash
docker build -t soundcloud-audio-api .
docker run --rm -p 3000:3000 soundcloud-audio-api
```

## API

- `GET /health`
- `GET /api/soundcloud/search?q=lofi&limit=10`
- `GET /api/soundcloud/resolve?url=https%3A%2F%2Fsoundcloud.com%2F...`
- `GET /api/soundcloud/stream?url=https%3A%2F%2Fsoundcloud.com%2F...`

Ví dụ:
```bash
curl "http://localhost:3000/api/soundcloud/search?q=lofi"
```

Lấy `webpage_url` từ kết quả tìm kiếm rồi gọi:
```text
http://localhost:3000/api/soundcloud/stream?url=ENCODED_TRACK_URL
```

Endpoint stream trả `audio/mpeg` MP3 128 kbps dạng stream, phù hợp để ESP32 đọc bằng HTTP audio client có hỗ trợ MP3.

## Deploy Render

Tạo Web Service từ GitHub repo chứa project này. Chọn Docker; Render sẽ tự dùng `Dockerfile` và `render.yaml`. Sau khi deploy, dùng URL service thay `http://localhost:3000`.

## Lưu ý

- Không cần cookies cho track công khai mà SoundCloud cho phép truy cập.
- Track riêng tư, bị giới hạn theo khu vực/quyền, yêu cầu đăng nhập hoặc bị SoundCloud chặn có thể không phát được.
- SoundCloud có thể thay đổi cơ chế truy cập; cập nhật yt-dlp khi extractor ngừng hoạt động.
- Chỉ sử dụng nội dung bạn có quyền nghe/phát và tuân thủ điều khoản SoundCloud, bản quyền và giới hạn API.
- Endpoint stream tiêu thụ băng thông của server; nên đặt giới hạn request/rate limit nếu public.
