# Docker Stack Template

Template triển khai nhanh 1 ứng dụng container (app chính) kèm đầy đủ lớp truy cập và vận hành:

- **Core**: Caddy + Cloudflare Tunnel.
- **Ops**: Dozzle, Filebrowser, WebSSH (có thể truy cập qua domain hoặc Tailscale hostname:port).
- **Access**: Tailscale + Keep-IP workflow.
- **Deploy Code**: sidecar self-deploy/app-control, mặc định tắt và chỉ bật khi `DOCKER_DEPLOY_CODE_ENABLED=true`.

Tài liệu chính đã được chuẩn hoá theo codebase hiện tại:

- Hướng dẫn triển khai tổng quát: `docs/DEPLOY.md`
- Hướng dẫn thay thế app/service mới: `docs/deploy.new.md`
- Tài liệu chi tiết từng dịch vụ (mỗi dịch vụ 1 file): thư mục `docs/services/`
- Tài liệu Deploy Code: `docs/services/deploy-code.md`
- One-file handoff cho coding agent khi thay app: `AGENT_APP_SWAP.md`
- Sync embedded files into agent handoff: `npm run agent-app-swap:sync`

## Cấu trúc compose

- `docker-compose/compose.core.yml`
- `docker-compose/compose.ops.yml`
- `docker-compose/compose.access.yml`
- `docker-compose/compose.deploy.yml`
- `compose.apps.yml`

Script điều phối chính:

- `docker-compose/scripts/dc.sh` (tự bật profile theo `ENABLE_*`)
- `docker-compose/scripts/ci-build.sh` (build có BuildKit cache + đo lường, dùng trong CI)
- `docker-compose/scripts/validate-env.js` (validate env trước deploy)

## Build có cache trên CI (BuildKit)

`ci-build.sh` build **từng service** với BuildKit `--cache-from/--cache-to`, rồi
`compose up --no-build`. Có 2 chế độ cache, tách rõ để CI và local không xung đột:

| Chế độ | Biến | Dùng ở |
|--------|------|--------|
| GitHub Actions | `CACHE_TYPE=gha` | `.github/runs/action.yml` (tự động) |
| Azure / local  | `CACHE_TYPE=local` + `LOCAL_CACHE_DIR` | `.azure/azure-pipelines.yml` (tự động) |

- GitHub Actions: dùng `type=gha,mode=max` (scope theo service) + cache tarball
  cho public image (xoay vòng theo tuần).
- Azure Pipelines: dùng `Cache@2` cho thư mục buildx layer + public image, build qua
  buildx driver `docker-container`.
- Cuối mỗi lần build, `ci-build.sh` in **BẢNG TỔNG HỢP**: mỗi service là `CACHED`,
  `PARTIAL` hay `REBUILT` kèm thời gian build → dễ thấy service nào tốn thời gian.

Chạy thủ công (dùng cấu hình mặc định `CACHE_TYPE=gha`):

```bash
npm run dockerapp-exec:ci-build
# hoặc local cache:
CACHE_TYPE=local LOCAL_CACHE_DIR="$HOME/.buildx-cache" bash docker-compose/scripts/ci-build.sh
```

> Dockerfile mẫu (`services/app/Dockerfile`) đã sắp xếp layer theo nguyên tắc
> "ổn định trước, hay đổi sau" (deps trước, source code cuối) + cache mount cho
> `npm` để tối đa hóa cache hit. Khi thay app, **giữ nguyên thứ tự layer** này.

## Lệnh thường dùng

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:all
npm run dockerapp-exec:up
npm run dockerapp-exec:ci-build
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
npm run dockerapp-exec:down
```

## Rclone — đồng bộ remote ↔ local (multi-path)

Kiến trúc 3 service (`docker-compose/compose.rclone.yml`):
`rclone-init` (decode config + validate) → `rclone-restore` (kéo data GATE=true về
trước khi app start) → `rclone-sync` (sidecar: restore nền non-gated + đẩy local→remote).

Hỗ trợ **nhiều path** qua biến `.env` (tối đa 10), mỗi path cấu hình độc lập:

```dotenv
ENABLE_RCLONE=true
RCLONE_CONFIG_BASE64=<base64 của rclone.conf>

# Path 1: data chính — restore xong TRƯỚC khi app start
RCLONE_PATH_1_LOCAL=/data/app/data
RCLONE_PATH_1_REMOTE=remote_store:my-bucket/app-data
RCLONE_PATH_1_MODE=both        # restore | sync | both
RCLONE_PATH_1_GATE=true        # true → app chờ path này restore xong

# Path 2: backup — chỉ đẩy lên, không chặn app
RCLONE_PATH_2_LOCAL=/data/deploy-code/backups
RCLONE_PATH_2_REMOTE=remote_store:my-bucket/deploy-backups
RCLONE_PATH_2_MODE=sync
RCLONE_PATH_2_GATE=false
```

> **Tương thích ngược:** Bỏ trống mọi `RCLONE_PATH_*` → stack tự fallback dùng
> `RCLONE_REMOTE_TARGET` + `RCLONE_LOCAL_PATH` như chế độ 1-path cũ (mode=both, gate=true).
> Xem chi tiết trong phần `RCLONE` của `.env.example`.


## Tiện ích clone template cho dịch vụ mới

Đã thêm script NodeJS:

```bash
node scripts/clone-stack.js --output /path/deployments --name my-new-service
```

Hoặc chạy interactive:

```bash
node scripts/clone-stack.js
```
