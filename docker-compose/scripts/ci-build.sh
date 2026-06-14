#!/usr/bin/env bash
# ================================================================
#  ci-build.sh — Build từng service với BuildKit cache, rồi up --no-build
#
#  Hai chế độ cache (tách rõ để CI và local không xung đột):
#    CACHE_TYPE=gha    → GitHub Actions cache (type=gha, mode=max)
#                        Dùng trong .github/runs/action.yml.
#    CACHE_TYPE=local  → Local layer cache (type=local) cho Azure Cache@2.
#                        Dùng trong .azure/azure-pipelines.yml.
#
#  Cải tiến đo lường: mỗi service được đo thời gian build và phân loại
#  CACHED (cache hit toàn bộ) hay REBUILT, in BẢNG TỔNG HỢP ở cuối job.
#
#  Generic & reusable: KHÔNG hardcode tên service. Lấy danh sách service
#  cần build từ `docker compose config` (đã resolve biến + profile qua dc.sh),
#  nên template tự thích nghi với mọi app mà dự án con khai báo.
# ================================================================
set -euo pipefail

# ── Config (đều override được qua env) ─────────────────────────
CACHE_TYPE="${CACHE_TYPE:-gha}"
LOCAL_CACHE_DIR="${LOCAL_CACHE_DIR:-$HOME/.buildx-cache}"
IMAGE_TAR="${IMAGE_TAR:-}"
# Wrapper compose: dc.sh tự nạp .env + chọn profile theo ENABLE_*.
COMPOSE_CMD="${COMPOSE_CMD:-bash docker-compose/scripts/dc.sh}"
# Tên project mặc định — KHỚP với --project-name trong dc.sh để tag
# build trùng tag compose up (tránh build lại do tag lệch).
PROJECT_NAME="${PROJECT_NAME:-myapp}"

# $DC = wrapper compose (dc.sh tự nạp .env + chọn profile)
DC() { $COMPOSE_CMD "$@"; }

command -v jq >/dev/null 2>&1 || { echo "❌ jq chưa được cài"; exit 1; }

echo "── ci-build.sh ──────────────────────────────────"
echo "  CACHE_TYPE : $CACHE_TYPE"
echo "  PROJECT    : $PROJECT_NAME"
[ "$CACHE_TYPE" = "local" ] && echo "  CACHE_DIR  : $LOCAL_CACHE_DIR"
[ -n "$IMAGE_TAR" ] && echo "  IMAGE_TAR  : $IMAGE_TAR"
echo "─────────────────────────────────────────────────"

# ── Lấy config JSON đã resolve (đã thay biến ${...}, đã có :local) ──
CONFIG_JSON="$(DC config --format json)"

# ── (tuỳ chọn) Nạp sẵn public images từ tar cache ─────────────
if [ -n "$IMAGE_TAR" ] && [ -f "$IMAGE_TAR" ]; then
  echo "==> Load public images từ cache: $IMAGE_TAR"
  docker load -i "$IMAGE_TAR" || true
fi

# ── Danh sách service CÓ build ────────────────────────────────
mapfile -t BUILD_SVCS < <(
  printf '%s' "$CONFIG_JSON" \
    | jq -r '.services | to_entries[] | select(.value.build != null) | .key'
)

# ── Báo cáo đo lường (cải tiến #3) ─────────────────────────────
# Mỗi dòng: "<svc>\t<status>\t<seconds>"  (status = REBUILT | CACHED | FAILED)
REPORT_ROWS=()

if [ "${#BUILD_SVCS[@]}" -eq 0 ]; then
  echo "ℹ️  Không có service nào cần build."
else
  for svc in "${BUILD_SVCS[@]}"; do
    # ✅ Lấy tag CHÍNH XÁC như compose sẽ dùng (đã resolve, có :local).
    #    Service không khai báo image: → dùng tên mặc định <project>-<svc>.
    #    Nhờ vậy tag build === tag up, không bao giờ lệch.
    img="$(printf '%s' "$CONFIG_JSON" | jq -r --arg s "$svc" '.services[$s].image // empty')"
    [ -z "$img" ] && img="${PROJECT_NAME}-${svc}"

    ctx="$(printf '%s' "$CONFIG_JSON"        | jq -r --arg s "$svc" '.services[$s].build.context // "."')"
    dockerfile="$(printf '%s' "$CONFIG_JSON" | jq -r --arg s "$svc" '.services[$s].build.dockerfile // "Dockerfile"')"

    # context từ `compose config` thường là absolute; dockerfile có thể tương đối.
    if [[ "$dockerfile" = /* ]]; then
      df="$dockerfile"
    else
      df="$ctx/$dockerfile"
    fi

    echo ""
    echo "==> Build [$svc] → $img"
    echo "    context   : $ctx"
    echo "    dockerfile: $df"

    CACHE_ARGS=()
    if [ "$CACHE_TYPE" = "gha" ]; then
      # scope=$svc → cache tách biệt từng service, không đè nhau.
      CACHE_ARGS+=(--cache-from "type=gha,scope=$svc")
      CACHE_ARGS+=(--cache-to   "type=gha,scope=$svc,mode=max")
    else
      # local: ghi cache mới ra thư mục -new rồi xoay vòng (tránh phình to).
      mkdir -p "$LOCAL_CACHE_DIR/$svc" "${LOCAL_CACHE_DIR}-new/$svc"
      CACHE_ARGS+=(--cache-from "type=local,src=$LOCAL_CACHE_DIR/$svc")
      CACHE_ARGS+=(--cache-to   "type=local,dest=${LOCAL_CACHE_DIR}-new/$svc,mode=max")
    fi

    # ── Đo lường: thời gian + CACHED/REBUILT ───────────────────
    BUILD_LOG="$(mktemp)"
    BUILD_START=$(date +%s)
    set +e
    docker buildx build \
      --tag "$img" \
      --file "$df" \
      --provenance=false \
      --progress=plain \
      --load \
      "${CACHE_ARGS[@]}" \
      "$ctx" 2>&1 | tee "$BUILD_LOG"
    RC=${PIPESTATUS[0]}
    set -e
    BUILD_SEC=$(( $(date +%s) - BUILD_START ))

    if [ "$RC" -ne 0 ]; then
      REPORT_ROWS+=("${svc}	FAILED	${BUILD_SEC}")
      rm -f "$BUILD_LOG"
      echo "[FATAL] Build service '$svc' thất bại (exit=$RC)." >&2
      exit "$RC"
    fi

    # Heuristic phân loại cache: nếu MỌI step đều "CACHED" và không có
    # dòng nào thực thi lệnh (không có "DONE" cho RUN/COPY mới) → CACHED.
    # Đếm số bước CACHED so với tổng số bước.
    TOTAL_STEPS=$(grep -cE '^#[0-9]+ ' "$BUILD_LOG" 2>/dev/null || echo 0)
    CACHED_HINTS=$(grep -cE 'CACHED' "$BUILD_LOG" 2>/dev/null || echo 0)
    if [ "$CACHED_HINTS" -gt 0 ] && ! grep -qE 'transferring|exporting layers|sha256:.*done' "$BUILD_LOG"; then
      STATUS="CACHED"
    elif [ "$CACHED_HINTS" -gt 0 ]; then
      STATUS="PARTIAL"   # một phần cache, một phần build lại
    else
      STATUS="REBUILT"
    fi
    REPORT_ROWS+=("${svc}	${STATUS}	${BUILD_SEC}")
    rm -f "$BUILD_LOG"
    echo "    ✓ [$svc] $STATUS trong ${BUILD_SEC}s"
  done

  # Local cache rotation (tránh cache phình to vô hạn)
  if [ "$CACHE_TYPE" = "local" ] && [ -d "${LOCAL_CACHE_DIR}-new" ]; then
    rm -rf "$LOCAL_CACHE_DIR"
    mv "${LOCAL_CACHE_DIR}-new" "$LOCAL_CACHE_DIR"
  fi
fi

# ── Start toàn bộ stack, KHÔNG build lại (ảnh đã có sẵn) ───────
echo ""
echo "==> docker compose up -d --no-build"
DC up -d --no-build --remove-orphans

# ── (tuỳ chọn) Lưu public images vào tar cache cho lần sau ────
if [ -n "$IMAGE_TAR" ] && [ ! -f "$IMAGE_TAR" ]; then
  echo "==> Save public images vào cache: $IMAGE_TAR"
  mapfile -t PUB_IMAGES < <(
    printf '%s' "$CONFIG_JSON" \
      | jq -r '.services | to_entries[] | select(.value.build == null) | .value.image' \
      | sort -u
  )
  if [ "${#PUB_IMAGES[@]}" -gt 0 ]; then
    docker save "${PUB_IMAGES[@]}" -o "$IMAGE_TAR" || true
  fi
fi

# ── BẢNG TỔNG HỢP BUILD (cải tiến #3) ─────────────────────────
echo ""
echo "================ BUILD SUMMARY ================"
if [ "${#REPORT_ROWS[@]}" -eq 0 ]; then
  echo "  (không có service nào được build — toàn bộ dùng image prebuilt)"
else
  printf "  %-24s %-10s %8s\n" "SERVICE" "STATUS" "TIME(s)"
  printf "  %-24s %-10s %8s\n" "------------------------" "----------" "--------"
  TOTAL_T=0
  for row in "${REPORT_ROWS[@]}"; do
    svc="${row%%	*}"
    rest="${row#*	}"
    status="${rest%%	*}"
    secs="${rest##*	}"
    printf "  %-24s %-10s %8s\n" "$svc" "$status" "$secs"
    TOTAL_T=$((TOTAL_T + secs))
  done
  printf "  %-24s %-10s %8s\n" "------------------------" "----------" "--------"
  printf "  %-24s %-10s %8s\n" "TOTAL" "" "$TOTAL_T"
fi
echo "==============================================="

echo "✅ ci-build.sh hoàn tất."
