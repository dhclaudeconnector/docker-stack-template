# Tailscale services (`docker-compose/compose.access.yml`)

## Vai trò
- Truy cập riêng tư qua tailnet cho môi trường nội bộ.
- Kèm cơ chế keep-ip backup/restore state.
- Toàn bộ state/certs lưu trên host tại `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib`.

## Kích hoạt
- `ENABLE_TAILSCALE=true`.
- Linux: `tailscale-linux` + keep-ip linux jobs.
- Windows: `tailscale-windows` + keep-ip windows jobs.

## ENV bắt buộc khi bật
- `TAILSCALE_AUTHKEY`
- `TAILSCALE_TAILNET_DOMAIN`

## ENV optional quan trọng
- `DOCKER_VOLUMES_ROOT` (default `./.docker-volumes`)
- `TAILSCALE_TAGS` (default `tag:container`)
- `TAILSCALE_KEEP_IP_ENABLE` (`true|false`)
- `TAILSCALE_KEEP_IP_FIREBASE_URL` (bắt buộc nếu keep-ip bật)
- `TAILSCALE_KEEP_IP_CERTS_DIR` (default `/var/lib/tailscale/certs`)
- `TAILSCALE_KEEP_IP_INTERVAL_SEC` (default 30)
- `TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE`
- `TAILSCALE_CLIENTID` hoặc `TAILSCALE_CLIENDID`
- `TAILSCALE_OAUTH_SECRET` (ưu tiên) hoặc fallback `TAILSCALE_AUTHKEY` cho API call.

## Keep-IP logic
- `prepare`: khôi phục state/certs trước khi daemon chạy.
- `backup-loop`: định kỳ đẩy state/certs lên Firebase RTDB.
- Nếu bật `REMOVE_HOSTNAME`, script sẽ gọi API để dọn hostname cũ tránh conflict IP.

## Kiểm tra
- Container tailscale chạy ổn định.
- Có thể resolve/truy cập `https://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}`.

## Hostname + port cho dịch vụ Ops
- Dozzle: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${DOZZLE_HOST_PORT:-18080}`
- Filebrowser: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${FILEBROWSER_HOST_PORT:-18081}`
- WebSSH: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${WEBSSH_HOST_PORT:-17681}`
