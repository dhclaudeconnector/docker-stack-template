# App service (`compose.apps.yml`)

## Vai trò
- Service ứng dụng chính, mặc định build từ `services/app`.

## Cấu hình chính
- Image local tag: `${PROJECT_NAME}-app:local`
- Build context: `./services/app`
- Port expose localhost: `127.0.0.1:${APP_HOST_PORT}:${APP_PORT}`
- Logs volume: `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/logs:/app/logs`
- Healthcheck: `wget http://localhost:${APP_PORT}${HEALTH_PATH}`

## ENV bắt buộc
- `APP_PORT`: port app lắng nghe trong container.
- `PROJECT_NAME`, `DOMAIN`: tạo hostname public.
- `CADDY_AUTH_USER`, `CADDY_AUTH_HASH`: basic auth.

## ENV optional
- `APP_HOST_PORT` (default 3000): chỉ truy cập localhost host machine.
- `NODE_ENV` (default production).
- `HEALTH_PATH` (default `/health`).
- `DOCKER_VOLUMES_ROOT` (default `./.docker-volumes`).
- `TAILSCALE_TAILNET_DOMAIN`: dùng cho route HTTPS nội bộ qua caddy_1.

## Routing
- Public host: `${PROJECT_NAME}.${DOMAIN}` (+ alias).
- Internal HTTPS host: `${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}` với `tls internal`.
