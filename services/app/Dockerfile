# syntax=docker/dockerfile:1.7
# ================================================================
#  services/app/Dockerfile — Sample Node app (generic template)
#
#  Layer được sắp xếp theo nguyên tắc "ổn định trước, hay đổi sau"
#  để TỐI ĐA HÓA cache hit khi build lại:
#    1. Base image + tạo user (gần như không bao giờ đổi)
#    2. Cài dependency (chỉ rebuild khi package*.json đổi)
#    3. Copy source code (đổi thường xuyên nhất → để CUỐI)
#
#  Dùng kèm BuildKit cache (xem docker-compose/scripts/ci-build.sh):
#    --mount=type=cache giúp tái dùng ~/.npm giữa các lần build.
#
#  Dự án con thay app: đổi base image / lệnh cài deps / CMD cho phù hợp,
#  nhưng GIỮ NGUYÊN thứ tự layer để không mất cache.
# ================================================================
FROM node:20-alpine

# ── Layer ổn định: user không phải root để bảo mật ──────────────
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# ── Layer dependency: copy manifest TRƯỚC, cài deps ─────────────
# Chỉ rebuild layer này khi package*.json thay đổi → cache hit cao.
# Cache mount /root/.npm tái dùng package đã tải giữa các lần build.
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev

# ── Layer source code: copy sau cùng (đổi nhiều nhất) ───────────
COPY . .

# Tạo thư mục log và phân quyền.
RUN mkdir -p /app/logs && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
