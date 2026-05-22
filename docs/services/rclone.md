# Rclone sync service (`docker-compose/compose.rclone.yml`)

## Vai trò
- Đồng bộ một chiều định kỳ dữ liệu từ thư mục `.docker-volumes/` (local) lên remote storage (S3-compatible, SFTP, v.v.).
- Sử dụng cấu hình `rclone.conf` để quản lý thông tin credentials và cấu hình các loại remote khác nhau.
- Hỗ trợ union remote (`type = union` với `list_action = join`) để hợp nhất danh sách tập tin giữa local và remote khi truy vấn.
- Thích hợp để làm giải pháp backup tự động cho toàn bộ dữ liệu runtime của dự án.

## Compose layer
- File: `docker-compose/compose.rclone.yml`.
- Kích hoạt qua cờ `ENABLE_RCLONE=true` trong file `.env`.
- Service chạy độc lập ở chế độ nền (sidecar), không chặn hoặc phụ thuộc vào các dịch vụ ứng dụng khác.

## Services
### `rclone`
- Image: `rclone/rclone:latest`
- Profile: `rclone`
- Entrypoint: `/entrypoint.sh` mount từ `services/rclone/entrypoint.sh`.
- Volumes mount:
  - Cấu hình: `./services/rclone/rclone.conf` vào `/config/rclone/rclone.conf:ro`.
  - Script chạy: `./services/rclone/entrypoint.sh` vào `/entrypoint.sh:ro`.
  - Dữ liệu: `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}` vào `/data`.

## File cấu hình
- `services/rclone/rclone.conf.example`: File mẫu chứa định nghĩa 3 block remote:
  - `[local_data]`: Alias trỏ vào dữ liệu mount tại `/data`.
  - `[remote_store]`: Cấu hình S3/SFTP remote đích (cần điền thông tin thật).
  - `[combined]`: Union remote ghép `local_data` và `remote_store`.
- `services/rclone/entrypoint.sh`: Chứa script bash validate các biến môi trường và chạy vòng lặp vô hạn `rclone sync` mỗi `RCLONE_SYNC_INTERVAL_SEC` giây.

## ENV bắt buộc
- `ENABLE_RCLONE`: `true|false`, bật/tắt profile Rclone trong `dc.sh`.
- `RCLONE_REMOTE_TARGET`: Remote đích để đồng bộ, định dạng: `remote_name:path/to/bucket` (ví dụ: `remote_store:my-bucket/docker-volumes`).

## ENV tùy chọn
- `RCLONE_SYNC_INTERVAL_SEC`: Giây giữa 2 lần sync (mặc định: `20`).
- `RCLONE_LOCAL_PATH`: Thư mục dữ liệu nguồn trong container (mặc định: `/data`).
- `RCLONE_LOG_LEVEL`: Mức độ ghi log của rclone (mặc định: `NOTICE`).
- `RCLONE_DRY_RUN`: Chạy thử nghiệm không ghi dữ liệu thật (`true|false`, mặc định: `false`).
- `RCLONE_EXTRA_FLAGS`: Các tham số bổ sung cho lệnh rclone sync (ví dụ: `--exclude "*.tmp"`).

## Hướng dẫn setup và sử dụng
1. Copy cấu hình mẫu thành cấu hình thật:
   ```bash
   cp services/rclone/rclone.conf.example services/rclone/rclone.conf
   ```
2. Điền thông tin kết nối remote thật của bạn vào block `[remote_store]` trong `services/rclone/rclone.conf`.
3. Bật cấu hình và thiết lập remote đích trong `.env`:
   ```env
   ENABLE_RCLONE=true
   RCLONE_REMOTE_TARGET=remote_store:ten-bucket-cua-ban/docker-volumes
   ```
4. Khởi động dịch vụ:
   ```bash
   bash docker-compose/scripts/dc.sh up -d rclone
   ```
5. Kiểm tra log đồng bộ:
   ```bash
   bash docker-compose/scripts/dc.sh logs -f rclone
   ```
