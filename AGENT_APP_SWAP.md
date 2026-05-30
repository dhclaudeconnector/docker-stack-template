# AGENT_APP_SWAP.md

Single-file contract for replacing the `app` service with minimal prompt tokens.

## 1) How To Use

1. Run `npm run agent-app-swap:sync` before sending this file to an agent.
2. Send this file and one short task prompt (use the Prompt Template in section 7).
3. Apply returned full files into your source tree (copy-paste replace).

## 2) Scope And Invariants

### Goal

Replace only the application layer while preserving Core/Ops/Access/Auth logic.

### Must Keep (NEVER Violate)

1. Service name stays `app` in `compose.apps.yml`.
2. Container name stays `main-app`.
3. `app` service stays on network `app_net`.
4. All Caddy labels use `${ENV_VAR}` expansion — no hard-coded domains, ports, or secrets.
5. `APP_PORT` is the single source of truth for the container listen port.
6. `HEALTH_PATH` is used in the app healthcheck — must point to a real working endpoint.
7. App healthcheck stays: `wget -qO- http://localhost:${APP_PORT}${HEALTH_PATH} || exit 1`.
8. Persistent data uses `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/...` bind mounts only.
9. Tinyauth and Litestream services must remain in `docker-compose/compose.auth.yml`.
10. App routes must be protected by Caddy `forward_auth` to Tinyauth — never use Caddy Basic Auth.
11. `depends_on: litestream-restore: condition: service_completed_successfully` AND `tinyauth: condition: service_healthy` must remain in app service.
12. If app uses SQLite: must integrate Litestream restore gate — app cannot start before it completes.
13. Core/Ops/Auth/Access behavior must not change unless explicitly requested.
14. `restart: unless-stopped` must be on all long-running services.
15. All new services must join `app_net` network.

### Litestream Invariants

16. When app uses SQLite: add the data volume to BOTH `litestream-restore` AND `litestream` in `compose.auth.yml`.
17. DB path in `litestream.yml` must exactly match the path where the app writes the SQLite file on disk.
18. Set `LITESTREAM_REPLICATE_DBS=tinyauth,app` when app uses SQLite.
19. First deploy: `LITESTREAM_INIT_MODE=true`. After first init: set `false` permanently.
20. NEVER set `LITESTREAM_INIT_MODE=true` when a replica already exists on S3 — the container will exit with error.

### Rclone Invariants

21. Rclone syncs everything under `${DOCKER_VOLUMES_ROOT}` (mounted as `/data` inside the container).
22. Do NOT place app data volumes outside `${DOCKER_VOLUMES_ROOT}` unless explicitly requested — they will not be synced.
23. `rclone.conf` (not `rclone.conf.example`) must exist at `services/rclone/rclone.conf`.
24. `RCLONE_REMOTE_TARGET` format: `<remote_name_in_conf>:<bucket_or_path>`. The remote name must match a `[section]` in `rclone.conf`.

### Tinyauth Invariants

25. `TINYAUTH_USERS` in `.env` uses `$$` (double dollar) to escape bcrypt hashes — dc.sh normalizes them at runtime.
26. `TINYAUTH_APP_URL` must be the exact public HTTPS URL where tinyauth is accessible (no trailing slash).
27. These four Caddy `forward_auth` labels MUST all be present on every protected app service:
    - `caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}`
    - `caddy.forward_auth.uri=/api/auth/caddy`
    - `caddy.forward_auth.header_up=X-Forwarded-Proto https`
    - `caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups`

## 3) Default Editable Files

- `compose.apps.yml`
- `services/app/**`
- `.env.example` (if new app env is required)
- `docker-compose/compose.auth.yml` (if auth/backup layer changes)
- `services/litestream/litestream.yml` (if app uses SQLite)
- `services/litestream/entrypoint.sh` (if app SQLite needs restore gate)
- `docker-compose/scripts/validate-env.js` (if new env validation is required)
- `docs/services/app.md`
- `docs/services/litestream.md` (if app uses SQLite)
- `docs/services/tinyauth.md` (if auth labels/env change)
- `docker-compose/compose.rclone.yml` (if rclone configuration changes)
- `services/rclone/rclone.conf.example` (if remote storage targets change)
- `services/rclone/entrypoint.sh` (if rclone sync logic needs adjustment)
- `docs/services/rclone.md` (for rclone sync documentation updates)

## 4) Common Failure Patterns

**Read this entire section before making any changes.**

### 4a) Litestream

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| `INIT_MODE=true but database file already exists` — container exits with error | DB exists but `LITESTREAM_INIT_MODE` still `true` | Set `LITESTREAM_INIT_MODE=false` |
| App blocked at startup, log: `Replica not found` | `LITESTREAM_INIT_MODE=false` + no S3 replica yet | Set `LITESTREAM_INIT_MODE=true` for first deploy only |
| Litestream running but app DB not replicated silently | `LITESTREAM_REPLICATE_DBS` doesn't include `app` | Set `LITESTREAM_REPLICATE_DBS=tinyauth,app` |
| App DB not restored on fresh deploy | Data volume missing in `litestream-restore` service | Add volume to BOTH `litestream-restore` AND `litestream` in `compose.auth.yml` |
| Restore succeeds but app cannot open DB | Path mismatch between `litestream.yml` and app's actual DB path | Match `path:` in `litestream.yml` exactly to the app's SQLite file path |
| `litestream-restore` succeeds but app crashes on DB open | Filename in `LITESTREAM_APP_DB_FILE` differs from what the app creates | Align `LITESTREAM_APP_DB_FILE` to the actual filename the app uses |

**Checklist when adding SQLite to app (do ALL before declaring done):**

- [ ] `litestream.yml`: add DB entry with exact container path (e.g. `/data/app/my.db`)
- [ ] `compose.auth.yml` — `litestream-restore` volumes: add `- ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/data:/data/app`
- [ ] `compose.auth.yml` — `litestream` volumes: add the same volume entry as above
- [ ] `.env.example`: add `LITESTREAM_APP_DB_FILE`, `LITESTREAM_APP_S3_PATH`; update `LITESTREAM_REPLICATE_DBS=tinyauth,app`
- [ ] `services/litestream/entrypoint.sh`: verify `*,app,*` case calls `restore_db "app" "/data/app/${LITESTREAM_APP_DB_FILE:-app.db}"`
- [ ] `compose.apps.yml` app service: verify `depends_on.litestream-restore.condition: service_completed_successfully`

### 4b) Rclone

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| Container exits immediately: `config file not found at /config/rclone/rclone.conf` | `rclone.conf` not created from example | `cp services/rclone/rclone.conf.example services/rclone/rclone.conf` then fill credentials |
| Sync loop runs but no files transferred | `RCLONE_DRY_RUN=true` | Set `RCLONE_DRY_RUN=false` after verifying with dry-run |
| `Failed to find remote "<name>"` error in logs | Remote name in `RCLONE_REMOTE_TARGET` doesn't match `[section]` in `rclone.conf` | Use the exact section name, e.g. `remote_store:bucket/path` |
| App data not being backed up by rclone | App data volume is outside `${DOCKER_VOLUMES_ROOT}` | Keep all app volumes under `${DOCKER_VOLUMES_ROOT}` — rclone only syncs that directory |
| Authentication / permission error from S3/R2 | Wrong `access_key_id` or `secret_access_key` in `rclone.conf` | Regenerate keys in provider console and update `rclone.conf` |

**Rclone setup order (first time):**

1. `cp services/rclone/rclone.conf.example services/rclone/rclone.conf`
2. Fill `[remote_store]` section in `rclone.conf` with actual credentials
3. Set `RCLONE_REMOTE_TARGET=remote_store:<bucket>/docker-volumes` in `.env`
4. Test: `RCLONE_DRY_RUN=true`, start stack, verify logs show expected file list
5. Set `RCLONE_DRY_RUN=false` and `ENABLE_RCLONE=true`

### 4c) Tinyauth

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| All requests return 401 even with correct password | `TINYAUTH_TRUSTED_PROXIES` doesn't include Docker network ranges | Keep default: `127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` |
| Cookie rejected on every request (login redirect loop) | `TINYAUTH_COOKIE_SECURE=true` but traffic is plain HTTP | Use HTTPS (Cloudflare tunnel / Tailscale) or set `false` for local HTTP testing only |
| OAuth redirect fails or goes to wrong URL | `TINYAUTH_APP_URL` doesn't match actual tinyauth public URL | Set to the exact URL (e.g. `https://auth.myapp.dpdns.org`), no trailing slash |
| App starts before tinyauth is ready (race condition / 503) | Missing `depends_on: tinyauth: condition: service_healthy` in app service | Add to app service in `compose.apps.yml` |
| Forward auth passes but user headers are empty in app | `copy_headers` label missing or misspelled | Verify: `caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups` |
| Login accepted but cookie immediately rejected | bcrypt hash uses `$` instead of `$$` in `.env` | Use `$$2a$$10$$...` in `.env` file — dc.sh unescapes to `$` at runtime |
| Tinyauth healthcheck fails at startup | DB path wrong or volume not mounted | Verify `TINYAUTH_DB_FILE` and that `${DOCKER_VOLUMES_ROOT}/tinyauth` is mounted at `/data` |

### 4d) Caddy Labels

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| Second virtual-host on service not routed | Used `caddy2=` instead of `caddy_1=` | Use `caddy_1`, `caddy_2`, `caddy_3`... (underscore + number, not number alone) |
| SSE / WebSocket streaming breaks or hangs | Missing `flush_interval=-1` | Add `caddy.reverse_proxy.flush_interval=-1` for streaming/SSE apps |
| Service accessible without auth | `forward_auth` labels missing or incomplete | Verify all four `forward_auth` labels present on every protected service |
| Port mismatch / connection refused in proxy | Hard-coded port in `{{upstreams}}` | Always use `{{upstreams ${APP_PORT:-3000}}}` — never hard-code |
| Caddy logs `no upstream` | Service not on `app_net` | Add `networks: [app_net]` to the service |

## 5) Required Validation Commands

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
```

If validation cannot run, agent must state why.

## 6) Output Contract (Token-Optimized)

Agent must return only:

1. `RESULT: OK` or `RESULT: BLOCKED`
2. `CHANGED_FILES: <comma-separated relative paths>`
3. Full content for changed files only, with this exact wrapper:

```text
===FILE:<relative/path>===
<full file content>
===END_FILE===
```

Rules:

- No diff format.
- No unchanged files.
- Keep explanation minimal (only for blockers/assumptions).
- If only one file changed, return only that one full file block.

## 7) Prompt Template

```text
Use AGENT_APP_SWAP.md as the only context source.

Task: Replace service `app` with the spec below, preserving all invariants in sections 2 and 4.

APP_SPEC:
- Runtime: <node|python|go|java|rust|prebuilt-image|other>
- Delivery: <build|image>
- Image: <registry/image:tag> (if Delivery=image)
- Build context: <path> (if Delivery=build)
- Internal port: <number>
- Health path: <path>
- Required env vars: <KEY1,KEY2,...>
- Persistent container paths: <path1,path2,...>
- SQLite DBs needing Litestream: <none|DB_FILE_ENV:container_path:S3_PATH_ENV>
- Auth exposure: <protected-by-tinyauth|public|custom>
- Startup command: <command>

Do:
1) Apply code changes in repo.
2) Keep Tinyauth `forward_auth` labels in app service unless APP_SPEC says public/custom.
3) Keep Tinyauth/Litestream services in `docker-compose/compose.auth.yml`.
4) If app uses SQLite, complete every item in the Litestream checklist (section 4a) before finishing.
5) Run required validation commands (section 5).
6) Return output exactly using the Output Contract in section 6.
```

## 8) Embedded Project Snapshot (Auto-Generated)

Tracked files:

- `.env.example`
- `compose.apps.yml`
- `docker-compose/compose.core.yml`
- `docker-compose/compose.auth.yml`
- `docker-compose/compose.ops.yml`
- `docker-compose/compose.access.yml`
- `docker-compose/scripts/dc.sh`
- `docker-compose/scripts/validate-env.js`
- `docker-compose/scripts/validate-compose.js`
- `services/litestream/litestream.yml`
- `services/litestream/entrypoint.sh`
- `docs/services/tinyauth.md`
- `docs/services/litestream.md`

Plus:

- `DIRECTORY_STRUCTURE` snapshot (tree, depth-limited)

<!-- BEGIN:EMBEDDED_FILES -->
Generated at: 2026-05-22T07:33:37.556Z
Use this snapshot as direct editing context.

### `DIRECTORY_STRUCTURE`
```text
./
  - -gitignore/
    - .gitkeep
  - .azure/
    - azure-pipelines.yml
  - .claude/
    - worktrees/
  - .codex/
    - AGENTS.md
  - .github/
    - runs/
      - action.yml
    - scripts/
      - collect-artifacts.sh
      - detect-os.sh
      - pull-env.sh
      - setup-linux.sh
    - workflows/
      - deploy.yml
  - cloudflared/
    - config.yml
    - config.yml.example
    - credentials.json
  - docker-compose/
    - scripts/
      - dc.sh
      - down.sh
      - logs.sh
      - up.sh
      - validate-compose.js
      - validate-env.js
      - validate-ts.js
    - compose.access.yml
    - compose.auth.yml
    - compose.core.yml
    - compose.deploy.yml
    - compose.ops.yml
    - compose.rclone.yml
  - docs/
    - .http/
      - deploy-code.cloudflared.http
      - deploy-code.tailscale.http
    - services/
      - app.md
      - caddy.md
      - cloudflared.md
      - deploy-code.md
      - dozzle.md
      - filebrowser.md
      - litestream.md
      - rclone.md
      - tailscale.md
      - tinyauth.md
      - webssh.md
    - deploy.md
    - deploy.new.md
  - scripts/
    - .cloneignore
    - .env.cloneignore
    - clone-stack.js
    - sync-agent-app-swap.js
  - services/
    - app/
      - Dockerfile
      - index.js
      - package.json
    - deploy-code/
      - public/
      - src/
      - Dockerfile
      - package-lock.json
      - package.json
    - litestream/
      - entrypoint.sh
      - litestream.yml
    - rclone/
      - entrypoint.sh
      - rclone.conf
      - rclone.conf.example
    - webssh/
      - Dockerfile
  - tailscale/
    - acl.sample.hujson
    - Dockerfile.watchdog
    - serve.json
    - tailscale-init.bak.js
    - tailscale-init.js
    - tailscale-keep-ip.js
    - tailscale-watchdog.js
  - tasks/
    - 2026-05-12/
      - 2026-05-12-01-bo-sung-tinyauth.md
      - plan-trien-khai-litestream-tinyauth.md
    - templates/
      - README.md
      - task-template.md
  - .env
  - .env.example
  - .env.local
  - .gitignore
  - .opushforce.message
  - AGENT_APP_SWAP.md
  - ANTIGRAVITY.md
  - CHANGE_LOGS_USER.md
  - CHANGE_LOGS.md
  - CLAUDE.md
  - compose.apps.yml
  - package.json
  - project-api.http
  - README.md
```

### `.env.example`
```text
# ================================================================
#  .env.example — Docker Stack Template
#  Copy to .env, then fill in deployment-specific values.
#  Example: cp .env.example .env
# ================================================================

# ================================================================
#  CORE — Required for every deployment
# ================================================================

# Project name: used as docker project/network prefix + subdomain base + tailscale hostname
PROJECT_NAME=myapp
PROJECT_NAME_TAILSCALE=myapp

# Root domain — no http://, no trailing slash
DOMAIN=${PROJECT_NAME}.dpdns.org

# ================================================================
#  CI / REMOTE ENV — Used by pipeline sync and stop-listener scripts
# ================================================================
DOTENVRTDB_ROOT_URL=https://your-project-default-rtdb.region.firebasedatabase.app/env.json?auth=replace-me
DOTENVRTDB_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DOTENVRTDB_PATH_URL=demo

DOTENVRTDB_URL=${DOTENVRTDB_ROOT_URL}/${DOTENVRTDB_PATH_URL}.json?auth=${DOTENVRTDB_SECRET}
STOP_LISTENER_ENABLED=true
STOP_FIREBASE_URL=${DOTENVRTDB_ROOT_URL}/${DOTENVRTDB_PATH_URL}-stop-id.json?auth=${DOTENVRTDB_SECRET}
# Firebase Realtime Database URL used to store both:
# - state key  (tailscaled.state backup)
# - certs key  (/var/lib/tailscale/certs backup)
TAILSCALE_KEEP_IP_FIREBASE_URL=${DOTENVRTDB_ROOT_URL}/${DOTENVRTDB_PATH_URL}-tailscale-keep-ip.json?auth=${DOTENVRTDB_SECRET}

# ================================================================
#  CADDY + TINYAUTH — Tinyauth protects routes through Caddy forward_auth
# ================================================================
# Email for Caddy SSL via Let's Encrypt
CADDY_EMAIL=admin@${DOMAIN}

# Public HTTPS URL where Tinyauth is exposed by Cloudflared/Tailscale.
TINYAUTH_APP_URL=https://auth.${DOMAIN}
# Internal port exposed by Tinyauth container.
TINYAUTH_PORT=3000
# SQLite database filename stored in ${DOCKER_VOLUMES_ROOT}/tinyauth.
TINYAUTH_DB_FILE=tinyauth.db
# Static users, comma-separated. Must be username:bcrypt_hash[:totp].
# Generate with: docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --interactive
# Choose "format for Docker" so bcrypt "$" characters are escaped as "$$".
# The hash below is only a shape example; validate-env requires a deployment-specific hash.
TINYAUTH_USERS=admin:$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u
# Automatically redirect to OAuth provider. Options: none, github, google, generic
TINYAUTH_OAUTH_AUTO_REDIRECT=none
# Secure cookie flag. Keep true behind HTTPS tunnels; set false only for plain local HTTP testing.
TINYAUTH_COOKIE_SECURE=true
# Trust reverse proxy headers from Caddy/Cloudflared/Tailscale.
TINYAUTH_TRUSTED_PROXIES=127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
# Log verbosity. Options: trace, debug, info, warn, error
TINYAUTH_LOG_LEVEL=info
# OAuth provider config. Google: https://console.cloud.google.com/apis/credentials
TINYAUTH_GOOGLE_CLIENT_ID=
TINYAUTH_GOOGLE_CLIENT_SECRET=
# GitHub OAuth app: https://github.com/settings/developers
TINYAUTH_GITHUB_CLIENT_ID=
TINYAUTH_GITHUB_CLIENT_SECRET=
# Generic OAuth/OIDC provider. Callback path: /api/oauth/callback/generic
TINYAUTH_GENERIC_CLIENT_ID=
TINYAUTH_GENERIC_CLIENT_SECRET=
TINYAUTH_GENERIC_AUTH_URL=
TINYAUTH_GENERIC_TOKEN_URL=
TINYAUTH_GENERIC_USER_INFO_URL=
TINYAUTH_GENERIC_SCOPES=openid email profile
TINYAUTH_GENERIC_REDIRECT_URL=https://auth.${DOMAIN}/api/oauth/callback/generic
TINYAUTH_GENERIC_NAME=Generic
# Optional OAuth whitelist, comma-separated email/domain/regex values.
TINYAUTH_OAUTH_WHITELIST=

# ================================================================
#  LITESTREAM — SQLite backup/replication to S3-compatible storage
# ================================================================
# Enable Litestream profile. First deploy: set LITESTREAM_INIT_MODE=true, init app, then set false.
ENABLE_LITESTREAM=true
# true = skip restore and create fresh DB; false = require restore before app starts.
LITESTREAM_INIT_MODE=true
# DB list to protect. Options: tinyauth, app, tinyauth,app
LITESTREAM_REPLICATE_DBS=tinyauth
# S3 endpoint examples:
# - Supabase: https://<project-ref>.supabase.co/storage/v1/s3
# - AWS S3: https://s3.amazonaws.com
LITESTREAM_S3_ENDPOINT=https://s3.amazonaws.com
LITESTREAM_S3_BUCKET=replace-me
LITESTREAM_S3_ACCESS_KEY_ID=replace-me
LITESTREAM_S3_SECRET_ACCESS_KEY=replace-me
# Per-DB replica paths. Keep each SQLite DB on a different object prefix.
LITESTREAM_TINYAUTH_S3_PATH=tinyauth/tinyauth.db
LITESTREAM_APP_DB_FILE=app.db
LITESTREAM_APP_S3_PATH=app/app.db
# Safety-first defaults from the PocketBase reference config.
LITESTREAM_SYNC_INTERVAL=5s
LITESTREAM_SNAPSHOT_INTERVAL=30m
LITESTREAM_RETENTION=48h
LITESTREAM_RETENTION_CHECK_INTERVAL=1h

# ================================================================
#  RCLONE — Sync .docker-volumes lên remote mỗi 20s
#  Local (.docker-volumes) là nguồn sự thật (primary storage).
#  Remote là đích backup/sync (một chiều: local → remote).
#  Union remote dùng list_action=join để hợp nhất file listing.
#
#  Bước setup:
#    1. cp services/rclone/rclone.conf.example services/rclone/rclone.conf
#    2. Điền thông tin remote vào [remote_store] trong rclone.conf
#    3. Đặt RCLONE_REMOTE_TARGET=remote_store:tên-bucket/data
#    4. Bật ENABLE_RCLONE=true
# ================================================================
ENABLE_RCLONE=false

# Remote đích — format: <tên remote trong rclone.conf>:<bucket hoặc path>
# Ví dụ S3/R2:   remote_store:my-bucket/docker-volumes
# Ví dụ SFTP:    remote_store:/backups/docker-volumes
RCLONE_REMOTE_TARGET=remote_store:replace-me/docker-volumes

# Khoảng thời gian giữa 2 lần sync (giây). Mặc định: 20
RCLONE_SYNC_INTERVAL_SEC=20

# Thư mục local trong container (không đổi nếu không có lý do đặc biệt)
RCLONE_LOCAL_PATH=/data

# Log level: NOTICE (mặc định) | INFO | DEBUG
RCLONE_LOG_LEVEL=NOTICE

# Chạy thử không ghi thật (true/false). Dùng để kiểm tra trước khi bật thật.
RCLONE_DRY_RUN=false

# Cờ bổ sung cho rclone sync (tùy chọn, để trống nếu không cần)
# Ví dụ: --exclude "*.tmp" --bwlimit 10M --exclude ".git/**"
RCLONE_EXTRA_FLAGS=

# ================================================================
#  APPLICATION — Change these per deployment
# ================================================================

# Docker image to run as the main application
APP_IMAGE=node:20-alpine

# Port the app exposes inside the container
APP_PORT=3000

# Localhost port published on the host machine
APP_HOST_PORT=3000

# Optional health check path
HEALTH_PATH=/health

# Node.js / generic runtime env
NODE_ENV=production

# Root host folder for all container runtime data (bind mounts)
DOCKER_VOLUMES_ROOT=./.docker-volumes


# ================================================================
#  FEATURE FLAGS — Enable or disable optional services
# ================================================================
ENABLE_DOZZLE=true
ENABLE_FILEBROWSER=true
ENABLE_WEBSSH=true
ENABLE_TAILSCALE=false
# ================================================================
#  OPS PORTS — Dozzle/Filebrowser/WebSSH local + Tailnet access
# ================================================================
# Host ports for ops services (used by compose.ops.yml)
DOZZLE_HOST_PORT=18080
FILEBROWSER_HOST_PORT=18081
WEBSSH_HOST_PORT=17681
# Bind IP for ops service ports:
# - 127.0.0.1: localhost only (safe default)
# - 0.0.0.0: allow direct access via Tailscale/LAN host IP
OPS_HOST_BIND_IP=0.0.0.0

# ================================================================
#  DOCKER DEPLOY CODE — Optional self-deploy / app control sidecar
# ================================================================

# Keep false by default. When true, dc.sh adds the deploy-code Compose profile.
DOCKER_DEPLOY_CODE_ENABLED=false

# Sidecar UI/API ports:
# - DOCKER_DEPLOY_CODE_PORT is inside the container.
# - DOCKER_DEPLOY_CODE_HOST_PORT is direct host/Tailnet access.
DOCKER_DEPLOY_CODE_PORT=53999
DOCKER_DEPLOY_CODE_HOST_PORT=15399

# Public Cloudflare/Caddy hostname for the Deploy Code UI.
# Add the same hostname to cloudflared/config.yml ingress.
DOCKER_DEPLOY_CODE_CADDY_HOSTS=deploy.${DOMAIN}

# API token is strongly recommended when exposed beyond localhost.
# Leave blank while disabled; fill a long random value before enabling.
DOCKER_DEPLOY_CODE_API_TOKEN=
DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=true

# Repo/Git: sidecar mounts this repo into /workspace and uses existing git auth.
DOCKER_DEPLOY_CODE_REPO_DIR=/workspace
DOCKER_DEPLOY_CODE_REMOTE=origin
DOCKER_DEPLOY_CODE_BRANCH=main
DOCKER_DEPLOY_CODE_GIT_CLEAN=false

# Deploy target: rebuild/recreate only the configured Compose service(s).
DOCKER_DEPLOY_CODE_COMPOSE_SCRIPT=docker-compose/scripts/dc.sh
DOCKER_DEPLOY_CODE_DEPLOY_SERVICES=app
DOCKER_DEPLOY_CODE_RESTART_CONTAINERS=
DOCKER_DEPLOY_CODE_DEPLOY_COMMAND=
DOCKER_DEPLOY_CODE_POST_DEPLOY_COMMAND=

# Env commit keys updated after Git/ZIP deploy for cache/version tracking.
DOCKER_DEPLOY_CODE_ENV_FILE=.env
DOCKER_DEPLOY_CODE_ENV_COMMIT_ID_KEY=_DOTENVRTDB_RUNNER_COMMIT_ID
DOCKER_DEPLOY_CODE_ENV_COMMIT_SHORT_ID_KEY=_DOTENVRTDB_RUNNER_COMMIT_SHORT_ID
DOCKER_DEPLOY_CODE_ENV_COMMIT_AT_KEY=_DOTENVRTDB_RUNNER_COMMIT_AT

# Poll Git automatically. Prefer check-only before enabling auto deploy.
DOCKER_DEPLOY_CODE_POLL_ENABLED=false
DOCKER_DEPLOY_CODE_POLL_INTERVAL_SEC=300
DOCKER_DEPLOY_CODE_AUTO_DEPLOY_ON_CHANGE=false
DOCKER_DEPLOY_CODE_RUN_ON_START=false

# Container/service controls are allowlisted by default.
DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED=true
DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL=false
DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST=app
DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST=main-app,deploy-code
DOCKER_DEPLOY_CODE_CONTAINER_LOG_DEFAULT_LINES=200
DOCKER_DEPLOY_CODE_CONTAINER_LOG_MAX_LINES=2000
DOCKER_DEPLOY_CODE_CONTAINER_ACTION_TIMEOUT_SEC=600

# ZIP source deploy safety defaults.
DOCKER_DEPLOY_CODE_ZIP_MAX_MB=200
DOCKER_DEPLOY_CODE_ZIP_STRIP_TOP_LEVEL=true
DOCKER_DEPLOY_CODE_ZIP_DELETE_MISSING=false
DOCKER_DEPLOY_CODE_ZIP_BACKUP_BEFORE_APPLY=true
DOCKER_DEPLOY_CODE_ZIP_EXCLUDES=.git,.env,.docker-volumes,node_modules
DOCKER_DEPLOY_CODE_ZIP_DEPLOY_AFTER_APPLY=true

# Logs/backups inside sidecar; host volumes live under ${DOCKER_VOLUMES_ROOT}/deploy-code.
DOCKER_DEPLOY_CODE_LOG_DIR=/app/logs
DOCKER_DEPLOY_CODE_BACKUP_DIR=/app/backups
DOCKER_DEPLOY_CODE_TEMP_DIR=/tmp/deploy-code
DOCKER_DEPLOY_CODE_LOG_TAIL_LINES=200

# ================================================================
#  CLOUDFLARE TUNNEL — Public ingress mapping
# ================================================================

# Tunnel name used by Cloudflare / sync tooling
CLOUDFLARED_TUNNEL_NAME=${PROJECT_NAME}-tunnel-name

# Public hostnames exposed through the tunnel
CLOUDFLARED_TUNNEL_HOSTNAME_1=${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_2=main.${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_3=ttyd.${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_4=dozzle.${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_5=files.${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_6=deploy.${DOMAIN}
CLOUDFLARED_TUNNEL_HOSTNAME_7=auth.${DOMAIN}

# Internal services behind each hostname
CLOUDFLARED_TUNNEL_SERVICE_1=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_2=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_3=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_4=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_5=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_6=http://caddy:80
CLOUDFLARED_TUNNEL_SERVICE_7=http://caddy:80

# CI sync value for cloudflared/credentials.json
CLOUDFLARED_TUNNEL_CREDENTIALS_BASE64=file:base64:./cloudflared/credentials.json

# ================================================================
#  TAILSCALE — Only required if ENABLE_TAILSCALE=true
# ================================================================

# Optional: OAuth client ID for tailscale/tailscale-init.js
# Get from: https://login.tailscale.com/admin/settings/keys (Trust credentials)
# If using tailscale-init / keep-ip OAuth flow, set:
#   TAILSCALE_CLIENTID=<OAuth client ID>
#   TAILSCALE_AUTHKEY=<OAuth client secret, tskey-client-...>
TAILSCALE_CLIENTID=kFhHFn4CBE11CNTRL
# Get from: https://login.tailscale.com/admin/settings/keys
# Use Reusable + Ephemeral for CI runners.
# Auth key used by tailscale container to join tailnet and by scripts to request access token.
TAILSCALE_AUTHKEY=tskey-client-xxxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# ACL tags for this node, example: tag:ci,tag:container
TAILSCALE_TAGS=tag:container
# Optional: whether tailscaled should manage in-container DNS on `tailscale up`
# false de tranh loi "rename /etc/resolv.conf: device or resource busy" trong container runtime
TAILSCALE_ACCEPT_DNS=false
# Owners used when tailscale-init creates missing tagOwners
TAILSCALE_TAG_OWNERS=autogroup:admin
# Tailnet DNS suffix from Tailscale admin → DNS page
TAILSCALE_TAILNET_DOMAIN=your-tailnet.ts.net
# Used to auto-generate tailscale/serve.json (TS_SERVE_CONFIG) for Tailscale HTTPS.
# Optional: tailnet identifier used by tailscale-init API calls (default: -)
TAILSCALE_TS_TAILNET=-
# Optional: output path for generated serve config
TAILSCALE_SERVE_JSON_PATH=./tailscale/serve.json
# Optional: local upstream for Tailscale Serve proxy
TAILSCALE_SERVE_PROXY=http://127.0.0.1:80
# Keep same Tailscale identity/IP across restart by backing up tailscaled.state
# true  = enable backup/restore + remove existing hostname before start
# false = disable this behavior
TAILSCALE_KEEP_IP_ENABLE=false
# Optional: remove existing device(s) matching PROJECT_NAME before start
# If this var is missing/empty, runtime falls back to TAILSCALE_KEEP_IP_ENABLE.
# Set true to remove hostname even when KEEP_IP is false.
TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE=false
# Optional certs directory override (default: /var/lib/tailscale/certs)
TAILSCALE_KEEP_IP_CERTS_DIR=/var/lib/tailscale/certs
# Optional backup interval for keep-ip sidecar (seconds)
TAILSCALE_KEEP_IP_INTERVAL_SEC=30
# Optional: local ACL JSON/HuJSON file to merge missing tagOwners
TAILSCALE_ACL_JSON_PATH=./tailscale/acl.sample.hujson
# Optional watchdog mode:
# - monitor: chi log/canh bao, KHONG auto-heal
# - heal: cho phep reconnect + dns fix
TAILSCALE_WATCHDOG_MODE=heal
# Optional watchdog interval (seconds)
TAILSCALE_WATCHDOG_INTERVAL_SEC=30
# Optional repeat warning cadence (failed cycles)
TAILSCALE_WATCHDOG_ALERT_EVERY=5
# Optional periodic healthy log cadence (0 = moi cycle)
TAILSCALE_WATCHDOG_LOG_OK_EVERY=10
# Optional netcheck snapshot in warning logs
TAILSCALE_WATCHDOG_NETCHECK=true
# Optional minimum seconds between auto-reconnect attempts
TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC=60
# Optional failed cycles before auto-heal starts
TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK=2
# Optional: pass --accept-dns to `tailscale up`; false de tranh loi resolv.conf busy
TAILSCALE_WATCHDOG_UP_ACCEPT_DNS=false
# Optional DNS file inspection in sidecar (mac dinh false trong compose, tranh false-positive)
# TAILSCALE_WATCHDOG_DNS_CHECK=false
# Optional socket path (phu hop voi runtime thuc te)
# TAILSCALE_SOCKET=/tmp/tailscaled.sock




# ================================================================
#  RUNTIME — Auto-set by CI scripts. Do NOT edit manually.
# ================================================================

# CUR_OS=linux
# DOCKER_SOCK=/var/run/docker.sock
# COMPOSE_PROJECT_NAME=docker-stack-template
# CUR_WHOAMI=runner
# CUR_WORK_DIR=/home/runner/work
# WSL_WORKSPACE=/mnt/c/path/to/workspace
```

### `compose.apps.yml`
```yaml
# ================================================================
#  compose.apps.yml — Application Layer
#  Builds the bundled sample app from ./services/app
#
#  Subdomain: ${PROJECT_NAME}.${DOMAIN}
#
#  Minimal required env:
#    APP_PORT   — Port app listens on inside container
#    PROJECT_NAME, DOMAIN, CADDY_EMAIL, TINYAUTH_*, LITESTREAM_*
# ================================================================

services:
  app:
    container_name: "main-app"
    image: "${PROJECT_NAME:-myapp}-app:local"
    build:
      context: ./services/app
      dockerfile: Dockerfile
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      NODE_ENV: "${NODE_ENV:-production}"
      PORT: "${APP_PORT:-3000}"
    ports:
      - "127.0.0.1:${APP_HOST_PORT:-3000}:${APP_PORT:-3000}"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/logs:/app/logs
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/data:/app/data
    labels:
      # Public HTTP sites behind Cloudflare Tunnel.
      - "caddy=http://${PROJECT_NAME}.${DOMAIN}, http://main.${DOMAIN}, http://${DOMAIN}, http://${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}"
      - "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy.forward_auth.uri=/api/auth/caddy"
      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
      - "caddy.reverse_proxy={{upstreams ${APP_PORT:-3000}}}"
      # Internal HTTPS site for Tailscale / trusted LAN access.
      - "caddy_1=https://${PROJECT_NAME_TAILSCALE:-myapp}.${TAILSCALE_TAILNET_DOMAIN:-tailnet.local}"
      - "caddy_1.tls=internal"
      - "caddy_1.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy_1.forward_auth.uri=/api/auth/caddy"
      - "caddy_1.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy_1.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
      - "caddy_1.reverse_proxy={{upstreams ${APP_PORT:-3000}}}"
    networks: [app_net]
    depends_on:
      litestream-restore:
        condition: service_completed_successfully
      tinyauth:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test:
        - "CMD"
        - "sh"
        - "-c"
        - "wget -qO- http://localhost:${APP_PORT:-3000}${HEALTH_PATH:-/health} || exit 1"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

### `docker-compose/compose.core.yml`
```yaml
# ================================================================
#  compose.core.yml — Core Infrastructure
#  Always included: reverse proxy (Caddy) + tunnel (Cloudflare)
#
#  Required env:
#    PROJECT_NAME, DOMAIN, CADDY_EMAIL, CF_TUNNEL_TOKEN (or credentials file)
# ================================================================

networks:
  # Defined once here for the whole merged stack; overlay files join it by name.
  app_net:
    name: ${PROJECT_NAME:-myapp}_net

services:
  # ── Caddy: auto reverse proxy via Docker labels ────────────────
  caddy:
    container_name: "caddy"
    image: lucaslorentz/caddy-docker-proxy:2.9.1-alpine
    ports:
      - "80:80"
    volumes:
      - ${DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock:ro
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/caddy/data:/data
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/caddy/config:/config
    environment:
      CADDY_INGRESS_NETWORKS: ${PROJECT_NAME:-myapp}_net
    labels:
      caddy.email: "${CADDY_EMAIL}"
      caddy.auto_https: "disable_redirects"
    networks: [app_net]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:80"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  # ── Cloudflared: expose to Internet without opening ports ──────
  cloudflared:
    container_name: "cloudflared"
    image: cloudflare/cloudflared:latest
    command: tunnel --config /etc/cloudflared/config.yml run
    volumes:
      - ./cloudflared/config.yml:/etc/cloudflared/config.yml:ro
      - ./cloudflared/credentials.json:/etc/cloudflared/credentials.json:ro
    networks: [app_net]
    restart: unless-stopped
    depends_on:
      caddy:
        condition: service_healthy
```

### `docker-compose/compose.auth.yml`
```yaml
# ================================================================
#  compose.auth.yml — Auth + SQLite Backup Layer
#  Provides Tinyauth forward_auth and Litestream restore/replicate.
# ================================================================

services:
  litestream-restore:
    container_name: "litestream-restore"
    image: litestream/litestream:0.3.13
    profiles: [litestream]
    env_file:
      - ./.env
    entrypoint: ["/bin/sh", "/entrypoint.sh", "restore-only"]
    volumes:
      - ./services/litestream/litestream.yml:/etc/litestream.yml:ro
      - ./services/litestream/entrypoint.sh:/entrypoint.sh:ro
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tinyauth:/data/tinyauth
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/data:/data/app
    restart: "no"

  litestream:
    container_name: "litestream"
    image: litestream/litestream:0.3.13
    profiles: [litestream]
    env_file:
      - ./.env
    entrypoint: ["/bin/sh", "/entrypoint.sh"]
    volumes:
      - ./services/litestream/litestream.yml:/etc/litestream.yml:ro
      - ./services/litestream/entrypoint.sh:/entrypoint.sh:ro
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tinyauth:/data/tinyauth
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/data:/data/app
    depends_on:
      litestream-restore:
        condition: service_completed_successfully
    restart: unless-stopped

  tinyauth:
    container_name: "tinyauth"
    image: ghcr.io/steveiliop56/tinyauth:v5
    environment:
      TINYAUTH_APPURL: "${TINYAUTH_APP_URL:-https://auth.${DOMAIN}}"
      TINYAUTH_SERVER_PORT: "${TINYAUTH_PORT:-3000}"
      TINYAUTH_DATABASE_PATH: "/data/${TINYAUTH_DB_FILE:-tinyauth.db}"
      TINYAUTH_AUTH_USERS: "${TINYAUTH_USERS:-}"
      TINYAUTH_AUTH_SECURECOOKIE: "${TINYAUTH_COOKIE_SECURE:-true}"
      TINYAUTH_AUTH_TRUSTEDPROXIES: "${TINYAUTH_TRUSTED_PROXIES:-127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
      TINYAUTH_OAUTH_AUTOREDIRECT: "${TINYAUTH_OAUTH_AUTO_REDIRECT:-none}"
      TINYAUTH_OAUTH_WHITELIST: "${TINYAUTH_OAUTH_WHITELIST:-}"
      TINYAUTH_OAUTH_PROVIDERS_GOOGLE_CLIENTID: "${TINYAUTH_GOOGLE_CLIENT_ID:-}"
      TINYAUTH_OAUTH_PROVIDERS_GOOGLE_CLIENTSECRET: "${TINYAUTH_GOOGLE_CLIENT_SECRET:-}"
      TINYAUTH_OAUTH_PROVIDERS_GITHUB_CLIENTID: "${TINYAUTH_GITHUB_CLIENT_ID:-}"
      TINYAUTH_OAUTH_PROVIDERS_GITHUB_CLIENTSECRET: "${TINYAUTH_GITHUB_CLIENT_SECRET:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_CLIENTID: "${TINYAUTH_GENERIC_CLIENT_ID:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_CLIENTSECRET: "${TINYAUTH_GENERIC_CLIENT_SECRET:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_AUTHURL: "${TINYAUTH_GENERIC_AUTH_URL:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_TOKENURL: "${TINYAUTH_GENERIC_TOKEN_URL:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_USERINFOURL: "${TINYAUTH_GENERIC_USER_INFO_URL:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_SCOPES: "${TINYAUTH_GENERIC_SCOPES:-openid email profile}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_REDIRECTURL: "${TINYAUTH_GENERIC_REDIRECT_URL:-}"
      TINYAUTH_OAUTH_PROVIDERS_GENERIC_NAME: "${TINYAUTH_GENERIC_NAME:-Generic}"
      TINYAUTH_LOG_LEVEL: "${TINYAUTH_LOG_LEVEL:-info}"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tinyauth:/data
    labels:
      - "caddy=http://auth.${PROJECT_NAME}.${DOMAIN}, http://auth.${DOMAIN}, http://auth.${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}"
      - "caddy.reverse_proxy={{upstreams ${TINYAUTH_PORT:-3000}}}"
      - "caddy.reverse_proxy.header_up=X-Forwarded-Proto https"
    networks: [app_net]
    depends_on:
      litestream-restore:
        condition: service_completed_successfully
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "tinyauth", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

### `docker-compose/compose.ops.yml`
```yaml
# ================================================================
#  compose.ops.yml — Operational Tools
#  Feature-flagged via ENABLE_* env vars → dc.sh sets --profile
#
#  Profiles:
#    dozzle         — real-time container log viewer
#    filebrowser    — web file manager (mounts workspace + .docker-volumes)
#    webssh-linux   — browser SSH terminal (Linux runner)
#    webssh-windows — socat bridge to host ttyd (Windows runner)
#
#  Subdomain convention (auto-generated, no manual config):
#    logs.${PROJECT_NAME}.${DOMAIN}
#    files.${PROJECT_NAME}.${DOMAIN}
#    ttyd.${PROJECT_NAME}.${DOMAIN}
#
#  Optional localhost ports for Tailscale/host access:
#    DOZZLE_HOST_PORT=18080
#    FILEBROWSER_HOST_PORT=18081
#    WEBSSH_HOST_PORT=17681
#  Optional bind IP for direct Tailnet access by host ports:
#    OPS_HOST_BIND_IP=0.0.0.0
# ================================================================

services:
  # ── Dozzle: real-time container logs ──────────────────────────
  dozzle:
    container_name: "dozzle"
    profiles: [dozzle]
    image: amir20/dozzle:v10.3.3
    volumes:
      - ${DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock:ro
    environment:
      DOZZLE_NO_ANALYTICS: "true"
    ports:
      - "${OPS_HOST_BIND_IP:-127.0.0.1}:${DOZZLE_HOST_PORT:-18080}:8080"
    labels:
      - "caddy=http://logs.${PROJECT_NAME}.${DOMAIN}, http://logs.${DOMAIN}, http://dozzle.${DOMAIN}"
      - "caddy.reverse_proxy={{upstreams 8080}}"
      # Lỗi aborting with incomplete response với SSE (text/event-stream) qua Caddy reverse proxy
      #   — cần thêm flush_interval -1 để Caddy không buffer response mà stream thẳng về client.
      - "caddy.reverse_proxy.flush_interval=-1" # ← thêm dòng này
      - "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy.forward_auth.uri=/api/auth/caddy"
      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
    networks: [app_net]
    restart: unless-stopped

  # ── Filebrowser: browse and download log files ─────────────────
  filebrowser:
    container_name: "filebrowser"
    profiles: [filebrowser]
    image: filebrowser/filebrowser:v2.30.0
    command: --noauth --port 80 --root /srv --database /database/filebrowser.db
    ports:
      - "${OPS_HOST_BIND_IP:-127.0.0.1}:${FILEBROWSER_HOST_PORT:-18081}:80"
    volumes:
      - .:/srv/workspace # browse all project files
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}:/srv/docker-volumes:ro # all runtime data of services
      - ./logs:/srv/logs:ro # optional direct logs shortcut
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/filebrowser/database:/database
    labels:
      - "caddy=http://files.${PROJECT_NAME}.${DOMAIN}, http://files.${DOMAIN}"
      - "caddy.reverse_proxy={{upstreams 80}}"
      - "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy.forward_auth.uri=/api/auth/caddy"
      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
    networks: [app_net]
    restart: unless-stopped

  # ── WebSSH (Linux): ttyd container → SSH into host runner ──────
  webssh:
    container_name: "webssh"
    profiles: [webssh-linux]
    build: ./services/webssh
    command:
      - "ttyd"
      - "-W"
      - "ssh"
      - "-i"
      - "/root/.ssh/id_rsa"
      - "-o"
      - "StrictHostKeyChecking=no"
      - "-o"
      - "UserKnownHostsFile=/dev/null"
      - "-o"
      - "ConnectTimeout=10"
      - "-t"
      - "${CUR_WHOAMI:-runner}@host.docker.internal"
      - "cd ${CUR_WORK_DIR:-/home/runner} && exec ${SHELL:-/bin/bash}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${OPS_HOST_BIND_IP:-127.0.0.1}:${WEBSSH_HOST_PORT:-17681}:7681"
    volumes:
      - ./services/webssh/.ssh:/root/.ssh:ro
    labels:
      - "caddy=http://ttyd.${PROJECT_NAME}.${DOMAIN}, http://ttyd.${DOMAIN}"
      - "caddy.reverse_proxy={{upstreams 7681}}"
      - "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy.forward_auth.uri=/api/auth/caddy"
      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
    networks: [app_net]
    restart: unless-stopped

  # ── WebSSH (Windows): socat bridge → host ttyd process ─────────
  webssh-windows:
    container_name: "webssh-windows"
    profiles: [webssh-windows]
    image: alpine/socat:latest
    command: >
      TCP-LISTEN:7681,fork,reuseaddr
      TCP:host.docker.internal:7681
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${OPS_HOST_BIND_IP:-127.0.0.1}:${WEBSSH_HOST_PORT:-17681}:7681"
    labels:
      - "caddy=http://ttyd.${PROJECT_NAME}.${DOMAIN}"
      - "caddy.reverse_proxy={{upstreams 7681}}"
      - "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
      - "caddy.forward_auth.uri=/api/auth/caddy"
      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"
      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
    networks: [app_net]
    restart: unless-stopped
```

### `docker-compose/compose.access.yml`
```yaml
# ================================================================
#  compose.access.yml — Network Access Layer
#  Tailscale VPN — private mesh for internal team access
#
#  Profiles:
#    tailscale-linux   — kernel TUN mode (full features, Linux host)
#    tailscale-windows — userspace mode (Windows/WSL2 host)
#
#  Required env (when ENABLE_TAILSCALE=true):
#    TAILSCALE_AUTHKEY, TAILSCALE_TAGS
#  Optional keep-ip env:
#    TAILSCALE_KEEP_IP_ENABLE, TAILSCALE_KEEP_IP_FIREBASE_URL (state+certs),
#    TAILSCALE_KEEP_IP_CERTS_DIR, TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE,
#    TAILSCALE_KEEP_IP_INTERVAL_SEC,
#    TAILSCALE_CLIENTID
# ================================================================

services:
  # ── Keep IP prepare (Linux profile): optional restore + optional remove hostname ──
  tailscale-keep-ip-prepare-linux:
    container_name: "ts-keep-ip-prepare-linux"
    profiles: [tailscale-linux]
    image: node:20-alpine
    command: ["node", "/workspace/tailscale/tailscale-keep-ip.js", "prepare"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_KEEP_IP_ENABLE: "${TAILSCALE_KEEP_IP_ENABLE:-false}"
      TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE: "${TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE:-}"
      TAILSCALE_KEEP_IP_FIREBASE_URL: "${TAILSCALE_KEEP_IP_FIREBASE_URL:-}"
      TAILSCALE_KEEP_IP_STATE_FILE: /var/lib/tailscale/tailscaled.state
      TAILSCALE_KEEP_IP_CERTS_DIR: "${TAILSCALE_KEEP_IP_CERTS_DIR:-/var/lib/tailscale/certs}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
      TAILSCALE_TS_TAILNET: "${TAILSCALE_TS_TAILNET:--}"
      TAILSCALE_AUTHKEY: "${TAILSCALE_AUTHKEY:-}"
      TAILSCALE_CLIENTID: "${TAILSCALE_CLIENTID:-}"
    user: "0:0"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/workspace/tailscale
    networks: [app_net]
    restart: "no"

  # ── Keep IP prepare (Windows profile): optional restore + optional remove hostname ─
  tailscale-keep-ip-prepare-windows:
    container_name: "ts-keep-ip-prepare-windows"
    profiles: [tailscale-windows]
    image: node:20-alpine
    command: ["node", "/workspace/tailscale/tailscale-keep-ip.js", "prepare"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_KEEP_IP_ENABLE: "${TAILSCALE_KEEP_IP_ENABLE:-false}"
      TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE: "${TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE:-}"
      TAILSCALE_KEEP_IP_FIREBASE_URL: "${TAILSCALE_KEEP_IP_FIREBASE_URL:-}"
      TAILSCALE_KEEP_IP_STATE_FILE: /var/lib/tailscale/tailscaled.state
      TAILSCALE_KEEP_IP_CERTS_DIR: "${TAILSCALE_KEEP_IP_CERTS_DIR:-/var/lib/tailscale/certs}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
      TAILSCALE_TS_TAILNET: "${TAILSCALE_TS_TAILNET:--}"
      TAILSCALE_AUTHKEY: "${TAILSCALE_AUTHKEY:-}"
      TAILSCALE_CLIENTID: "${TAILSCALE_CLIENTID:-}"
    user: "0:0"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/workspace/tailscale
    networks: [app_net]
    restart: "no"

  # ── Tailscale: Linux kernel mode (NET_ADMIN + TUN) ─────────────
  tailscale-linux:
    container_name: "ts-linux"
    profiles: [tailscale-linux]
    image: tailscale/tailscale:stable
    hostname: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
    depends_on:
      tailscale-keep-ip-prepare-linux:
        condition: service_completed_successfully
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TS_AUTHKEY: "${TAILSCALE_AUTHKEY:-}"
      TS_USERSPACE: "false"
      TS_SOCKET: "${TAILSCALE_SOCKET:-/tmp/tailscaled.sock}"
      TS_SERVE_CONFIG: /config/serve/serve.json
      TS_EXTRA_ARGS: >-
        --advertise-tags=${TAILSCALE_TAGS:-tag:container}
        --accept-dns=${TAILSCALE_ACCEPT_DNS:-false}
        --accept-routes
      TS_STATE_DIR: /var/lib/tailscale
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/config/serve
      - tailscale-socket:/tmp
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    network_mode: host
    restart: unless-stopped

  # ── Tailscale: Windows/WSL2 userspace mode ─────────────────────
  tailscale-windows:
    container_name: "ts-windows"
    profiles: [tailscale-windows]
    image: tailscale/tailscale:stable
    hostname: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
    depends_on:
      tailscale-keep-ip-prepare-windows:
        condition: service_completed_successfully
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TS_AUTHKEY: "${TAILSCALE_AUTHKEY:-}"
      TS_USERSPACE: "true"
      TS_SOCKET: "${TAILSCALE_SOCKET:-/tmp/tailscaled.sock}"
      TS_SERVE_CONFIG: /config/serve/serve.json
      TS_EXTRA_ARGS: >-
        --advertise-tags=${TAILSCALE_TAGS:-tag:container}
        --accept-dns=${TAILSCALE_ACCEPT_DNS:-false}
      TS_STATE_DIR: /var/lib/tailscale
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/config/serve
      - tailscale-socket:/tmp
    networks: [app_net]
    restart: unless-stopped

  # ── Watchdog (Linux profile): monitor tailscale status/log only ───────
  tailscale-watchdog-linux:
    container_name: "ts-watchdog-linux"
    profiles: [tailscale-linux]
    build:
      context: .
      dockerfile: tailscale/Dockerfile.watchdog
    depends_on:
      tailscale-linux:
        condition: service_started
    command: ["node", "/workspace/tailscale/tailscale-watchdog.js"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_WATCHDOG_MODE: "${TAILSCALE_WATCHDOG_MODE:-heal}"
      TAILSCALE_WATCHDOG_INTERVAL_SEC: "${TAILSCALE_WATCHDOG_INTERVAL_SEC:-30}"
      TAILSCALE_WATCHDOG_ALERT_EVERY: "${TAILSCALE_WATCHDOG_ALERT_EVERY:-5}"
      TAILSCALE_WATCHDOG_LOG_OK_EVERY: "${TAILSCALE_WATCHDOG_LOG_OK_EVERY:-10}"
      TAILSCALE_WATCHDOG_NETCHECK: "${TAILSCALE_WATCHDOG_NETCHECK:-true}"
      TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC: "${TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC:-60}"
      TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK: "${TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK:-2}"
      TAILSCALE_WATCHDOG_UP_ACCEPT_DNS: "${TAILSCALE_WATCHDOG_UP_ACCEPT_DNS:-false}"
      # Sidecar cannot safely inspect tailscale container resolv.conf; use health/netcheck instead.
      TAILSCALE_WATCHDOG_DNS_CHECK: "${TAILSCALE_WATCHDOG_DNS_CHECK:-false}"
      TAILSCALE_WATCHDOG_AUTO_RECONNECT: "true"
      TAILSCALE_WATCHDOG_DNS_FIX: "false"
      TAILSCALE_SOCKET: "${TAILSCALE_SOCKET:-/tmp/tailscaled.sock}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
    user: "0:0"
    volumes:
      - ./tailscale:/workspace/tailscale:ro
      - tailscale-socket:/tmp
    networks: [app_net]
    restart: unless-stopped

  # ── Watchdog (Windows profile): monitor tailscale status/log only ─────
  tailscale-watchdog-windows:
    container_name: "ts-watchdog-windows"
    profiles: [tailscale-windows]
    build:
      context: .
      dockerfile: tailscale/Dockerfile.watchdog
    depends_on:
      tailscale-windows:
        condition: service_started
    command: ["node", "/workspace/tailscale/tailscale-watchdog.js"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_WATCHDOG_MODE: "${TAILSCALE_WATCHDOG_MODE:-heal}"
      TAILSCALE_WATCHDOG_INTERVAL_SEC: "${TAILSCALE_WATCHDOG_INTERVAL_SEC:-30}"
      TAILSCALE_WATCHDOG_ALERT_EVERY: "${TAILSCALE_WATCHDOG_ALERT_EVERY:-5}"
      TAILSCALE_WATCHDOG_LOG_OK_EVERY: "${TAILSCALE_WATCHDOG_LOG_OK_EVERY:-10}"
      TAILSCALE_WATCHDOG_NETCHECK: "${TAILSCALE_WATCHDOG_NETCHECK:-true}"
      TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC: "${TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC:-60}"
      TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK: "${TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK:-2}"
      TAILSCALE_WATCHDOG_UP_ACCEPT_DNS: "${TAILSCALE_WATCHDOG_UP_ACCEPT_DNS:-false}"
      # Sidecar cannot safely inspect tailscale container resolv.conf; use health/netcheck instead.
      TAILSCALE_WATCHDOG_DNS_CHECK: "${TAILSCALE_WATCHDOG_DNS_CHECK:-false}"
      TAILSCALE_WATCHDOG_AUTO_RECONNECT: "true"
      TAILSCALE_WATCHDOG_DNS_FIX: "false"
      TAILSCALE_SOCKET: "${TAILSCALE_SOCKET:-/tmp/tailscaled.sock}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
    user: "0:0"
    volumes:
      - ./tailscale:/workspace/tailscale:ro
      - tailscale-socket:/tmp
    networks: [app_net]
    restart: unless-stopped

  # ── Keep IP backup loop (Linux profile): upload state periodically ─────
  tailscale-keep-ip-backup-linux:
    container_name: "ts-keep-ip-backup-linux"
    profiles: [tailscale-linux]
    image: node:20-alpine
    depends_on:
      tailscale-linux:
        condition: service_started
    command: ["node", "/workspace/tailscale/tailscale-keep-ip.js", "backup-loop"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_KEEP_IP_ENABLE: "${TAILSCALE_KEEP_IP_ENABLE:-false}"
      TAILSCALE_KEEP_IP_FIREBASE_URL: "${TAILSCALE_KEEP_IP_FIREBASE_URL:-}"
      TAILSCALE_KEEP_IP_STATE_FILE: /var/lib/tailscale/tailscaled.state
      TAILSCALE_KEEP_IP_CERTS_DIR: "${TAILSCALE_KEEP_IP_CERTS_DIR:-/var/lib/tailscale/certs}"
      TAILSCALE_KEEP_IP_INTERVAL_SEC: "${TAILSCALE_KEEP_IP_INTERVAL_SEC:-30}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
      TAILSCALE_TS_TAILNET: "${TAILSCALE_TS_TAILNET:--}"
    user: "0:0"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/workspace/tailscale
    networks: [app_net]
    restart: unless-stopped

  # ── Keep IP backup loop (Windows profile): upload state periodically ───
  tailscale-keep-ip-backup-windows:
    container_name: "ts-keep-ip-backup-windows"
    profiles: [tailscale-windows]
    image: node:20-alpine
    depends_on:
      tailscale-windows:
        condition: service_started
    command: ["node", "/workspace/tailscale/tailscale-keep-ip.js", "backup-loop"]
    # Compose vẫn ưu tiên giá trị khai báo explicit trong environment bên dưới.
    env_file:
      - ./.env
    environment:
      TAILSCALE_KEEP_IP_ENABLE: "${TAILSCALE_KEEP_IP_ENABLE:-false}"
      TAILSCALE_KEEP_IP_FIREBASE_URL: "${TAILSCALE_KEEP_IP_FIREBASE_URL:-}"
      TAILSCALE_KEEP_IP_STATE_FILE: /var/lib/tailscale/tailscaled.state
      TAILSCALE_KEEP_IP_CERTS_DIR: "${TAILSCALE_KEEP_IP_CERTS_DIR:-/var/lib/tailscale/certs}"
      TAILSCALE_KEEP_IP_INTERVAL_SEC: "${TAILSCALE_KEEP_IP_INTERVAL_SEC:-30}"
      PROJECT_NAME: "${PROJECT_NAME_TAILSCALE:-${PROJECT_NAME:-myapp}}"
      TAILSCALE_TS_TAILNET: "${TAILSCALE_TS_TAILNET:--}"
    user: "0:0"
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib:/var/lib/tailscale
      - ./tailscale:/workspace/tailscale
    networks: [app_net]
    restart: unless-stopped

volumes:
  tailscale-socket:
```

### `docker-compose/compose.rclone.yml`
```yaml
# ================================================================
#  compose.rclone.yml — rclone sync sidecar
#  Sync .docker-volumes lên remote mỗi RCLONE_SYNC_INTERVAL_SEC giây.
#
#  Local làm nguồn sự thật (primary), remote là backup đích.
#  Union remote (combined) dùng list_action=join để hợp nhất listing.
#
#  Bật qua: ENABLE_RCLONE=true trong .env
#
#  Env bắt buộc:
#    RCLONE_REMOTE_TARGET — vd: remote_store:bucket/data
#  Env tùy chọn:
#    RCLONE_SYNC_INTERVAL_SEC, RCLONE_LOG_LEVEL, RCLONE_DRY_RUN,
#    RCLONE_EXTRA_FLAGS, RCLONE_LOCAL_PATH
# ================================================================

services:
  rclone:
    container_name: "rclone"
    profiles: [rclone]
    image: rclone/rclone:latest
    entrypoint: ["/bin/sh", "/entrypoint.sh"]
    env_file:
      - ./.env
    environment:
      RCLONE_SYNC_INTERVAL_SEC: "${RCLONE_SYNC_INTERVAL_SEC:-20}"
      RCLONE_LOCAL_PATH: "${RCLONE_LOCAL_PATH:-/data}"
      RCLONE_REMOTE_TARGET: "${RCLONE_REMOTE_TARGET}"
      RCLONE_CONFIG_PATH: "/config/rclone/rclone.conf"
      RCLONE_LOG_LEVEL: "${RCLONE_LOG_LEVEL:-NOTICE}"
      RCLONE_DRY_RUN: "${RCLONE_DRY_RUN:-false}"
      RCLONE_EXTRA_FLAGS: "${RCLONE_EXTRA_FLAGS:-}"
    volumes:
      # Config rclone (chứa credentials — không commit)
      - ./services/rclone/rclone.conf:/config/rclone/rclone.conf:ro
      # Entrypoint script
      - ./services/rclone/entrypoint.sh:/entrypoint.sh:ro
      # Mount toàn bộ .docker-volumes làm data source
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}:/data
    networks: [app_net]
    restart: unless-stopped
```

### `docker-compose/scripts/dc.sh`
```bash
#!/usr/bin/env bash
# ================================================================
#  dc.sh — Docker Compose Orchestrator
#  Reads .env feature flags → auto-selects profiles → runs compose
#
#  Usage:
#    bash docker-compose/scripts/dc.sh up -d --build
#    bash docker-compose/scripts/dc.sh down
#    bash docker-compose/scripts/dc.sh logs -f
#    bash docker-compose/scripts/dc.sh ps
#    bash docker-compose/scripts/dc.sh config
#    bash docker-compose/scripts/dc.sh <any compose command>
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

expand_env_refs() {
  local value="$1"
  local ref replacement
  while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    ref="${BASH_REMATCH[1]}"
    replacement="${!ref-}"
    value="${value//\$\{$ref\}/$replacement}"
  done
  printf '%s' "$value"
}

load_env_file() {
  local env_file="${1:-.env}"
  local line key value

  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$(trim "$line")" ] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [ "${#value}" -ge 2 ]; then
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi

    # Backward-compatible with legacy .env entries that escaped "$" as "$$".
    value="${value//\$\$/\$}"
    value="$(expand_env_refs "$value")"
    export "$key=$value"
  done < "$env_file"
}

resolve_host_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s' "$path"
  elif [[ "$path" =~ ^[A-Za-z]:[\\/].* ]]; then
    printf '%s' "$path"
  else
    path="${path#./}"
    printf '%s' "$ROOT_DIR/$path"
  fi
}

prepare_docker_volume_dirs() {
  local volume_root
  volume_root="$(resolve_host_path "${DOCKER_VOLUMES_ROOT:-./.docker-volumes}")"

  mkdir -p \
    "$volume_root/app/logs" \
    "$volume_root/app/data" \
    "$volume_root/tinyauth" \
    "$volume_root/caddy/data" \
    "$volume_root/caddy/config" \
    "$volume_root/filebrowser/database" \
    "$volume_root/tailscale/var-lib" \
    "$volume_root/deploy-code/logs" \
    "$volume_root/deploy-code/backups" \
    "$volume_root/deploy-code/tmp" \
    "$volume_root/rclone/cache"

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  DATA_ROOT : $volume_root"
  fi
}

# ── Load .env ─────────────────────────────────────────────────────
if [ -f "$ROOT_DIR/.env" ]; then
  load_env_file "$ROOT_DIR/.env"
else
  echo "⚠️  .env not found — using defaults. Run: cp .env.example .env" >&2
fi

# Normalize tags to comma-separated form without spaces.
if [ -n "${TAILSCALE_TAGS:-}" ]; then
  TAILSCALE_TAGS="$(printf '%s' "$TAILSCALE_TAGS" | tr -d '[:space:]')"
  export TAILSCALE_TAGS
fi

# Default deploy-code public hostname. Override in .env when a different
# Cloudflare/Caddy hostname is required.
if [ -z "${DOCKER_DEPLOY_CODE_CADDY_HOSTS:-}" ]; then
  DOCKER_DEPLOY_CODE_CADDY_HOSTS="deploy.${DOMAIN:-localhost}"
  export DOCKER_DEPLOY_CODE_CADDY_HOSTS
fi

should_render_tailscale_serve() {
  case "${1:-}" in
    ""|up|start|restart|create|run|config|pull)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

render_tailscale_serve_config() {
  local tailnet_domain app_port serve_dir serve_file serve_hostname
  tailnet_domain="$(trim "${TAILSCALE_TAILNET_DOMAIN:-}")"
  app_port="$(trim "${APP_PORT:-3000}")"
  serve_hostname="${PROJECT_NAME:-myapp}.${tailnet_domain}"

  if [ -z "$tailnet_domain" ] || [ "$tailnet_domain" = "-" ]; then
    echo "❌ ENABLE_TAILSCALE=true nhưng TAILSCALE_TAILNET_DOMAIN chưa có giá trị hợp lệ." >&2
    echo "   Chạy: npm run tailscale-init (hoặc điền TAILSCALE_TAILNET_DOMAIN trong .env)." >&2
    exit 1
  fi

  if ! [[ "$app_port" =~ ^[0-9]+$ ]] || [ "$app_port" -lt 1 ] || [ "$app_port" -gt 65535 ]; then
    echo "❌ APP_PORT không hợp lệ: $app_port" >&2
    exit 1
  fi

  serve_dir="$ROOT_DIR/tailscale"
  serve_file="$serve_dir/serve.json"
  mkdir -p "$serve_dir"
  cat > "$serve_file" <<EOF
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${serve_hostname}:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:80"
        }
      }
    }
  }
}
EOF

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  TS_SERVE  : $serve_file (${serve_hostname} -> 127.0.0.1:80)"
  fi
}

# ── Detect OS (uname-based, not RUNNER_OS) ─────────────────────
UNAME_S="$(uname -s)"
UNAME_R="$(uname -r)"

if echo "$UNAME_R" | grep -qi "microsoft\|wsl"; then
  _OS="windows"
elif [ "$UNAME_S" = "Darwin" ]; then
  _OS="macos"
else
  _OS="${CUR_OS:-linux}"
fi

# ── Build --profile arguments from ENABLE_* flags ──────────────
PROFILE_ARGS=()

if [ "${ENABLE_DOZZLE:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile dozzle)
fi

if [ "${ENABLE_FILEBROWSER:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile filebrowser)
fi

if [ "${ENABLE_WEBSSH:-true}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile webssh-windows)
  else
    PROFILE_ARGS+=(--profile webssh-linux)
  fi
fi

if [ "${ENABLE_TAILSCALE:-false}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile tailscale-windows)
  else
    PROFILE_ARGS+=(--profile tailscale-linux)
  fi
fi

if [ "${ENABLE_LITESTREAM:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile litestream)
fi

if [ "${DOCKER_DEPLOY_CODE_ENABLED:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile deploy-code)
fi

if [ "${ENABLE_RCLONE:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile rclone)
fi

if [ "${ENABLE_TAILSCALE:-false}" = "true" ] && should_render_tailscale_serve "${1:-}"; then
  render_tailscale_serve_config
fi

prepare_docker_volume_dirs

# ── Compose file list ──────────────────────────────────────────
FILES=(
  -f "$ROOT_DIR/docker-compose/compose.core.yml"
  -f "$ROOT_DIR/docker-compose/compose.auth.yml"
  -f "$ROOT_DIR/docker-compose/compose.ops.yml"
  -f "$ROOT_DIR/docker-compose/compose.access.yml"
  -f "$ROOT_DIR/docker-compose/compose.deploy.yml"
  -f "$ROOT_DIR/docker-compose/compose.rclone.yml"
  -f "$ROOT_DIR/compose.apps.yml"
)

# ── Debug info (set DC_VERBOSE=1 to show) ─────────────────────
if [ "${DC_VERBOSE:-0}" = "1" ]; then
  echo "── dc.sh debug ──────────────────────────────────"
  echo "  OS        : $_OS"
  echo "  PROJECT   : ${PROJECT_NAME:-?}"
  echo "  DOMAIN    : ${DOMAIN:-?}"
  echo "  PROFILES  : ${PROFILE_ARGS[*]:-<none>}"
  echo "  FILES     : ${FILES[*]}"
  echo "─────────────────────────────────────────────────"
fi

# ── Execute ───────────────────────────────────────────────────
exec docker compose \
  "${FILES[@]}" \
  --project-directory "$ROOT_DIR" \
  --project-name "${PROJECT_NAME:-myapp}" \
  "${PROFILE_ARGS[@]}" \
  "$@"
```

### `docker-compose/scripts/validate-env.js`
```js
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found. Hãy tạo từ .env.example trước khi deploy.");
  process.exit(1);
}

function parseEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

const env = parseEnvFile(envPath);

function expandEnvReferences(values) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      const next = String(value || "").replace(pattern, (_match, name) => values[name] ?? "");
      if (next !== value) {
        values[key] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

expandEnvReferences(env);

const errors = [];
const warnings = [];
const ok = [];

function isBool(v) {
  return v === "true" || v === "false";
}

function checkPort(key, required = true) {
  const v = env[key];
  if (!v) {
    if (required) errors.push(`${key} is required`);
    else warnings.push(`${key} not set (optional)`);
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`${key} must be an integer in range 1..65535`);
    return;
  }
  ok.push(`${key}=${n}`);
}

function checkRequired(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    errors.push(`${key} is required (${desc})`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK`);
}

function checkOptional(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    warnings.push(`${key} optional: ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK (optional)`);
}

function isValidDomain(v) {
  if (v.startsWith("http://") || v.startsWith("https://")) return "must not include http/https";
  if (v.endsWith("/")) return "must not end with /";
  if (!v.includes(".")) return "must be a valid domain, e.g. example.com";
  return null;
}

function isValidHttpsJsonUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function isValidHttpsOrigin(v) {
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return "must start with https://";
    if (u.pathname !== "/" || u.search || u.hash) {
      return "must be an origin URL only, e.g. https://auth.example.com";
    }
    if (v.endsWith("/")) return "must not end with /";
    return null;
  } catch {
    return "must be a valid https URL";
  }
}

function normalizeDockerEscapedDollar(v) {
  return String(v || "").replace(/\$\$/g, "$");
}

const TINYAUTH_EXAMPLE_BCRYPT_HASH = "$2a$10$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u";

function validateTinyauthUsers(v) {
  const users = v.split(",").map((part) => part.trim()).filter(Boolean);
  if (!users.length) return "must contain at least one user";

  for (const entry of users) {
    const parts = entry.split(":");
    const username = (parts[0] || "").trim();
    const hash = normalizeDockerEscapedDollar(parts[1] || "");
    if (!username || parts.length < 2) {
      return "each entry must use username:bcrypt_hash[:totp]";
    }
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
      return "password must be a bcrypt hash, not a plain password";
    }
    if (hash === TINYAUTH_EXAMPLE_BCRYPT_HASH) {
      return "uses the bundled example bcrypt hash; generate a deployment-specific hash";
    }
  }

  return null;
}

function validateTrustedProxies(v) {
  const entries = v.split(",").map((part) => part.trim()).filter(Boolean);
  if (!entries.length) return "must contain at least one IP/CIDR";

  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split("/");
    if (extra !== undefined || !net.isIP(ip)) {
      return `invalid IP/CIDR entry: ${entry}`;
    }
    if (prefix !== undefined) {
      const n = Number(prefix);
      const max = net.isIP(ip) === 4 ? 32 : 128;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        return `invalid CIDR prefix in entry: ${entry}`;
      }
    }
  }

  return null;
}

function buildAppHost(project, domain) {
  const p = (project || "").trim().toLowerCase();
  const d = (domain || "").trim().toLowerCase();
  if (p && d && (d === p || d.startsWith(`${p}.`))) {
    return domain;
  }
  return `${project}.${domain}`;
}

// 1) Required core env from compose files
checkRequired("PROJECT_NAME", "docker project/network + subdomain prefix", (v) =>
  /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "only lowercase letters, numbers, hyphen"
);
checkRequired("DOMAIN", "root domain", isValidDomain);
checkRequired("CADDY_EMAIL", "caddy email label", (v) => (v.includes("@") ? null : "invalid email"));
checkRequired("TINYAUTH_APP_URL", "public HTTPS Tinyauth URL", isValidHttpsOrigin);
checkPort("TINYAUTH_PORT", true);
checkRequired("TINYAUTH_DB_FILE", "Tinyauth SQLite file", (v) =>
  v.includes("/") || v.includes("\\") ? "must be a filename, not a path" : null
);
checkRequired("TINYAUTH_USERS", "static users in username:bcrypt_hash format", validateTinyauthUsers);
checkRequired("TINYAUTH_COOKIE_SECURE", "secure cookie toggle", (v) => (isBool(v) ? null : "must be true|false"));
checkRequired("TINYAUTH_TRUSTED_PROXIES", "trusted Caddy/Cloudflared/Tailscale proxy CIDRs", validateTrustedProxies);
checkOptional("TINYAUTH_OAUTH_AUTO_REDIRECT", "none|github|google|generic", (v) =>
  v === "none" || /^[a-z][a-z0-9_-]*$/.test(v) ? null : "must be none or a provider id"
);
checkOptional("TINYAUTH_OAUTH_WHITELIST", "comma-separated OAuth email/domain/regex whitelist");
for (const [name, clientKey, secretKey] of [
  ["Google", "TINYAUTH_GOOGLE_CLIENT_ID", "TINYAUTH_GOOGLE_CLIENT_SECRET"],
  ["GitHub", "TINYAUTH_GITHUB_CLIENT_ID", "TINYAUTH_GITHUB_CLIENT_SECRET"],
  ["Generic", "TINYAUTH_GENERIC_CLIENT_ID", "TINYAUTH_GENERIC_CLIENT_SECRET"],
]) {
  const clientId = (env[clientKey] || "").trim();
  const clientSecret = (env[secretKey] || "").trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) errors.push(`${name} OAuth requires both ${clientKey} and ${secretKey}`);
    else ok.push(`${name} OAuth client/secret=OK (optional)`);
  }
}
for (const key of [
  "TINYAUTH_SECRET",
  "TINYAUTH_DISABLE_CONTINUE",
  "TINYAUTH_TRUST_PROXY",
  "TINYAUTH_ALLOWED_USERS",
  "TINYAUTH_ALLOWED_DOMAINS",
  "TINYAUTH_ALLOWED_GROUPS",
  "TINYAUTH_OIDC_ISSUER",
  "TINYAUTH_OIDC_CLIENT_ID",
  "TINYAUTH_OIDC_CLIENT_SECRET",
  "TINYAUTH_OIDC_SCOPES",
]) {
  if ((env[key] || "").trim()) {
    warnings.push(`${key} is legacy/deprecated for Tinyauth v5 and is not passed to the tinyauth container`);
  }
}
checkPort("APP_PORT", true);

// 2) Optional env from compose files
checkPort("APP_HOST_PORT", false);
checkPort("DOZZLE_HOST_PORT", false);
checkPort("FILEBROWSER_HOST_PORT", false);
checkPort("WEBSSH_HOST_PORT", false);
checkOptional("NODE_ENV", "app runtime env");
checkOptional("HEALTH_PATH", "health endpoint path", (v) => (v.startsWith("/") ? null : "must start with '/'"));
checkOptional("DOCKER_SOCK", "docker socket path override");
checkPort("DOCKER_DEPLOY_CODE_PORT", false);
checkPort("DOCKER_DEPLOY_CODE_HOST_PORT", false);
checkOptional("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public Caddy host for deploy-code UI/API");
checkOptional("DOCKER_DEPLOY_CODE_REPO_DIR", "repo path mounted inside deploy-code sidecar");
checkOptional("DOCKER_DEPLOY_CODE_BRANCH", "git branch to deploy");
checkOptional("DOCKER_DEPLOY_CODE_REMOTE", "git remote to fetch");
checkOptional("DOCKER_DEPLOY_CODE_COMPOSE_SCRIPT", "compose orchestration script inside repo");
checkOptional("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "comma-separated compose services to rebuild/redeploy");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED", "true|false toggle for container control API", (v) =>
  isBool(v) ? null : "must be true|false"
);
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL", "true|false toggle to allow all Docker containers", (v) =>
  isBool(v) ? null : "must be true|false"
);
checkOptional("DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST", "comma-separated compose services allowed for start/stop/restart/rebuild/logs");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST", "comma-separated containers allowed for start/stop/restart/logs/inspect");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_DEFAULT_LINES", "default container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_MAX_LINES", "max container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ACTION_TIMEOUT_SEC", "Docker action timeout seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_POLL_INTERVAL_SEC", "git polling interval seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_ZIP_MAX_MB", "max raw ZIP upload size in MB", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});

if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  checkRequired("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "service(s) deploy-code may rebuild/redeploy");
  checkRequired("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public deploy-code hostname for Caddy");

  const requireToken = (env.DOCKER_DEPLOY_CODE_REQUIRE_TOKEN || "true").trim();
  if (!isBool(requireToken)) {
    errors.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN must be true|false");
  } else if (requireToken === "true") {
    checkRequired("DOCKER_DEPLOY_CODE_API_TOKEN", "required when deploy-code token auth is enabled", (v) =>
      v.length >= 16 ? null : "must be at least 16 characters"
    );
  } else {
    warnings.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=false while deploy-code is enabled -> rely on Tinyauth / private network only");
  }
}

// 3) Flags
for (const key of ["ENABLE_DOZZLE", "ENABLE_FILEBROWSER", "ENABLE_WEBSSH", "ENABLE_TAILSCALE", "ENABLE_LITESTREAM", "DOCKER_DEPLOY_CODE_ENABLED", "DOCKER_DEPLOY_CODE_POLL_ENABLED", "DOCKER_DEPLOY_CODE_AUTO_DEPLOY_ON_CHANGE", "DOCKER_DEPLOY_CODE_RUN_ON_START", "DOCKER_DEPLOY_CODE_REQUIRE_TOKEN", "DOCKER_DEPLOY_CODE_GIT_CLEAN", "DOCKER_DEPLOY_CODE_ZIP_STRIP_TOP_LEVEL", "DOCKER_DEPLOY_CODE_ZIP_DELETE_MISSING", "DOCKER_DEPLOY_CODE_ZIP_BACKUP_BEFORE_APPLY", "DOCKER_DEPLOY_CODE_ZIP_DEPLOY_AFTER_APPLY"]) {
  const v = env[key];
  if (!v) {
    warnings.push(`${key} not set -> using default from scripts/compose`);
    continue;
  }
  if (!isBool(v)) errors.push(`${key} must be true|false`);
  else ok.push(`${key}=${v}`);
}

if ((env.ENABLE_LITESTREAM || "true") === "true") {
  const initMode = (env.LITESTREAM_INIT_MODE || "").trim();
  if (!isBool(initMode)) errors.push("LITESTREAM_INIT_MODE must be true|false");
  checkRequired("LITESTREAM_REPLICATE_DBS", "comma-separated SQLite DB ids, e.g. tinyauth or tinyauth,app");
  checkRequired("LITESTREAM_S3_ENDPOINT", "S3-compatible endpoint", (v) =>
    v.startsWith("http://") || v.startsWith("https://") ? null : "must start with http:// or https://"
  );
  checkRequired("LITESTREAM_S3_BUCKET", "S3 bucket");
  checkRequired("LITESTREAM_S3_ACCESS_KEY_ID", "S3 access key id");
  checkRequired("LITESTREAM_S3_SECRET_ACCESS_KEY", "S3 secret access key");
  checkRequired("LITESTREAM_TINYAUTH_S3_PATH", "Tinyauth replica path");
  checkOptional("LITESTREAM_APP_DB_FILE", "optional app SQLite filename");
  checkOptional("LITESTREAM_APP_S3_PATH", "optional app replica path");
  checkRequired("LITESTREAM_SYNC_INTERVAL", "Litestream sync interval");
  checkRequired("LITESTREAM_SNAPSHOT_INTERVAL", "Litestream snapshot interval");
  checkRequired("LITESTREAM_RETENTION", "Litestream retention");
  checkRequired("LITESTREAM_RETENTION_CHECK_INTERVAL", "Litestream retention check interval");
}

// 4) Files required by cloudflared mounts
const cfConfig = path.resolve(process.cwd(), "cloudflared/config.yml");
const cfCreds = path.resolve(process.cwd(), "cloudflared/credentials.json");
if (!fs.existsSync(cfConfig)) errors.push("cloudflared/config.yml missing (cloudflared mount required)");
else ok.push("cloudflared/config.yml present");
if (!fs.existsSync(cfCreds)) errors.push("cloudflared/credentials.json missing (cloudflared mount required)");
else ok.push("cloudflared/credentials.json present");

// 5) Optional webssh runtime tuning vars
if ((env.ENABLE_WEBSSH || "true") === "true") {
  if (!env.CUR_WHOAMI) warnings.push("CUR_WHOAMI optional (webssh linux default runner)");
  if (!env.CUR_WORK_DIR) warnings.push("CUR_WORK_DIR optional (webssh linux default /home/runner)");
  if (!env.SHELL) warnings.push("SHELL optional (webssh linux default /bin/bash)");
}

// 6) Tailscale + keep-ip rules based on compose.access.yml
if (env.ENABLE_TAILSCALE === "true") {
  checkRequired("TAILSCALE_AUTHKEY", "required by tailscale service", (v) =>
    v.startsWith("tskey-") ? null : "must start with tskey-"
  );
  checkRequired("TAILSCALE_TAILNET_DOMAIN", "required by dc.sh to render tailscale/serve.json", (v) =>
    v && v !== "-" ? null : "must not be empty or '-'"
  );
  checkOptional("TAILSCALE_TAGS", "advertise tags", (v) =>
    /^tag:[A-Za-z0-9][A-Za-z0-9_-]*(,tag:[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(v)
      ? null
      : "format must be tag:a,tag:b"
  );

  const keepIp = (env.TAILSCALE_KEEP_IP_ENABLE || "false").trim();
  if (!isBool(keepIp)) errors.push("TAILSCALE_KEEP_IP_ENABLE must be true|false");

  const keepRemove = (env.TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE || "").trim();
  if (keepRemove && !isBool(keepRemove)) {
    errors.push("TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE must be true|false when provided");
  }

  if (keepIp === "true") {
    checkRequired("TAILSCALE_KEEP_IP_FIREBASE_URL", "required when keep-ip enabled", (v) =>
      isValidHttpsJsonUrl(v) ? null : "must be https URL ending with .json"
    );
    checkOptional("TAILSCALE_KEEP_IP_CERTS_DIR", "certs dir path");
    checkOptional("TAILSCALE_KEEP_IP_INTERVAL_SEC", "backup interval seconds", (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
    });
  } else {
    warnings.push("TAILSCALE_KEEP_IP_ENABLE=false -> keep-ip backup/restore disabled");
  }

  const removeHostnameEnabled = keepRemove ? keepRemove === "true" : keepIp === "true";
  if (removeHostnameEnabled) {
    if (!env.TAILSCALE_CLIENTID) {
      errors.push("remove-hostname enabled requires TAILSCALE_CLIENTID");
    }
    const authKey = (env.TAILSCALE_AUTHKEY || "").trim();
    if (!authKey) {
      errors.push("remove-hostname enabled requires TAILSCALE_AUTHKEY");
    } else if (!authKey.startsWith("tskey-client-")) {
      errors.push("remove-hostname requires TAILSCALE_AUTHKEY in tskey-client-* format");
    }
  }
}

const project = env.PROJECT_NAME || "<project>";
const domain = env.DOMAIN || "<domain>";
const host = env.PROJECT_NAME || "myapp";
const tailnet = env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local";
const appHost = buildAppHost(project, domain);
ok.push(`subdomain preview: app=${appHost}`);
if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`subdomain preview: logs=logs.${appHost}`);
if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`subdomain preview: files=files.${appHost}`);
if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`subdomain preview: ttyd=ttyd.${appHost}`);
if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  ok.push(`subdomain preview: deploy-code=${env.DOCKER_DEPLOY_CODE_CADDY_HOSTS || `deploy.${domain}`}`);
}
if (env.ENABLE_TAILSCALE === "true") {
  const dozzlePort = env.DOZZLE_HOST_PORT || "18080";
  const filesPort = env.FILEBROWSER_HOST_PORT || "18081";
  const sshPort = env.WEBSSH_HOST_PORT || "17681";
  const deployCodePort = env.DOCKER_DEPLOY_CODE_HOST_PORT || "15399";
  ok.push(`tailnet host: https://${host}.${tailnet}`);
  if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`tailnet dozzle: http://${host}.${tailnet}:${dozzlePort}`);
  if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`tailnet filebrowser: http://${host}.${tailnet}:${filesPort}`);
  if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`tailnet webssh: http://${host}.${tailnet}:${sshPort}`);
  if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") ok.push(`tailnet deploy-code: http://${host}.${tailnet}:${deployCodePort}`);
}

console.log("\n📋 ENV VALIDATION REPORT");
console.log("─".repeat(60));

if (ok.length) {
  console.log(`\n✅ Valid (${ok.length})`);
  for (const s of ok) console.log(`  - ${s}`);
}
if (warnings.length) {
  console.log(`\n⚠️ Warnings (${warnings.length})`);
  for (const s of warnings) console.log(`  - ${s}`);
}
if (errors.length) {
  console.log(`\n❌ Errors (${errors.length})`);
  for (const s of errors) console.log(`  - ${s}`);
  console.log("\nDừng triển khai. Hãy sửa lỗi bắt buộc trước khi chạy up.\n");
  process.exit(1);
}

console.log("\n✅ Env hợp lệ. Có thể triển khai.\n");
```

### `docker-compose/scripts/validate-compose.js`
```js
#!/usr/bin/env node
// ================================================================
//  docker-compose/scripts/validate-compose.js
//  Runs `docker compose config` across all compose files to
//  validate the merged YAML resolves without errors.
// ================================================================
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FILES = [
  'docker-compose/compose.core.yml',
  'docker-compose/compose.auth.yml',
  'docker-compose/compose.ops.yml',
  'docker-compose/compose.access.yml',
  'docker-compose/compose.deploy.yml',
  'compose.apps.yml',
];

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const idx = s.indexOf('=');
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

function profileArgsFromEnv(env) {
  const profiles = [];
  const curOs = String(env.CUR_OS || process.platform).toLowerCase();
  const isWindows = curOs.includes('win');

  if (env.ENABLE_DOZZLE !== 'false') profiles.push('dozzle');
  if (env.ENABLE_FILEBROWSER !== 'false') profiles.push('filebrowser');
  if (env.ENABLE_WEBSSH !== 'false') profiles.push(isWindows ? 'webssh-windows' : 'webssh-linux');
  if (env.ENABLE_TAILSCALE === 'true') profiles.push(isWindows ? 'tailscale-windows' : 'tailscale-linux');
  if (env.ENABLE_LITESTREAM !== 'false') profiles.push('litestream');
  if (env.DOCKER_DEPLOY_CODE_ENABLED === 'true') profiles.push('deploy-code');

  return profiles.flatMap((profile) => ['--profile', profile]);
}

console.log('\n🐳  Compose Config Validation\n');

// Check all files exist
let abort = false;
for (const f of FILES) {
  if (!fs.existsSync(f)) {
    console.error(`❌  ${f} not found`);
    abort = true;
  } else {
    console.log(`    ✅  ${f}`);
  }
}
if (abort) process.exit(1);

const fileArgs = FILES.map(f => `-f ${f}`).join(' ');
const profileArgs = profileArgsFromEnv(parseEnvFile('.env'));
const args = [
  'compose',
  ...FILES.flatMap((f) => ['-f', f]),
  ...profileArgs,
  '--project-directory',
  process.cwd(),
  'config',
  '--quiet',
];

console.log(`\n    Running: docker compose ${fileArgs} ${profileArgs.join(' ')} config ...\n`);

try {
  execFileSync('docker', args, { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
  console.log('\n✅  Compose configuration is valid!\n');
} catch {
  console.log('\n❌  Compose validation failed — fix YAML errors above.\n');
  process.exit(1);
}
```

### `services/litestream/litestream.yml`
```yaml
# ================================================================
#  /etc/litestream.yml — Multi-DB SQLite replication
#
#  Biến bắt buộc:
#    LITESTREAM_S3_ENDPOINT          — vd: https://<id>.supabase.co/storage/v1/s3
#                                          hoặc https://s3.amazonaws.com
#    LITESTREAM_S3_BUCKET            — tên bucket
#    LITESTREAM_S3_ACCESS_KEY_ID     — S3 / Supabase access key
#    LITESTREAM_S3_SECRET_ACCESS_KEY — S3 / Supabase secret key
#
#  Mỗi DB dùng path riêng trên S3 để tránh ghi đè dữ liệu.
#  Thêm DB mới: copy block entry, đổi path + S3 path env.
# ================================================================

dbs:
  # ── Tinyauth SQLite ──────────────────────────────────────────────
  - path: /data/tinyauth/${TINYAUTH_DB_FILE}
    replicas:
      - type: s3
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_TINYAUTH_S3_PATH}
        access-key-id: ${LITESTREAM_S3_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_S3_SECRET_ACCESS_KEY}

        # Upload WAL frames lên S3 mỗi 5s
        # → mất tối đa 5s data nếu SIGKILL không có grace period
        sync-interval: ${LITESTREAM_SYNC_INTERVAL}

        # Tối ưu startup time:
        # Giảm snapshot-interval từ 1h → 30m.
        # Khi restore, Litestream phải replay WAL frames từ snapshot
        # cuối cùng đến hiện tại. Snapshot càng gần → replay càng ít
        # → restore nhanh hơn.
        # Với 30m: worst-case replay = 30 phút writes.
        # Chi phí: gấp đôi số lần tạo snapshot (vẫn nhỏ so với WAL).
        snapshot-interval: ${LITESTREAM_SNAPSHOT_INTERVAL}

        # Giữ 48h generations để tự dọn phiên bản cũ hơn
        retention: ${LITESTREAM_RETENTION}
        retention-check-interval: ${LITESTREAM_RETENTION_CHECK_INTERVAL}

  # ── App SQLite ───────────────────────────────────────────────────
  - path: /data/app/${LITESTREAM_APP_DB_FILE}
    replicas:
      - type: s3
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_APP_S3_PATH}
        access-key-id: ${LITESTREAM_S3_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_S3_SECRET_ACCESS_KEY}

        sync-interval: ${LITESTREAM_SYNC_INTERVAL}
        snapshot-interval: ${LITESTREAM_SNAPSHOT_INTERVAL}
        retention: ${LITESTREAM_RETENTION}
        retention-check-interval: ${LITESTREAM_RETENTION_CHECK_INTERVAL}
```

### `services/litestream/entrypoint.sh`
```bash
#!/bin/sh
set -e

CONFIG_PATH="${LITESTREAM_CONFIG_PATH:-/etc/litestream.yml}"
REPLICATE_DBS="${LITESTREAM_REPLICATE_DBS:-tinyauth}"

restore_db() {
  name="$1"
  db_path="$2"
  mkdir -p "$(dirname "$db_path")"

  if [ "${LITESTREAM_INIT_MODE:-false}" = "true" ]; then
    if [ -f "$db_path" ]; then
      echo "[ERROR] LITESTREAM_INIT_MODE=true but database file already exists: ${db_path}."
      echo "        Exiting with error to stop and check manually to prevent data loss."
      exit 1
    fi
    echo "[RESTORE] Forced restore in INIT MODE for ${name}: ${db_path}"
    if ! litestream restore -config "$CONFIG_PATH" -if-replica-exists "$db_path"; then
      echo "[ERROR] Forced restore failed for ${name} in INIT MODE."
      exit 1
    fi
    if [ ! -f "$db_path" ]; then
      echo "[ERROR] Replica not found for ${name} in INIT MODE. Forced restore failed."
      exit 1
    fi
    return 0
  fi

  if [ -f "$db_path" ]; then
    echo "[RESTORE] Database already exists, skipping restore for ${name}: ${db_path}"
    return 0
  fi

  echo "[RESTORE] ${name}: ${db_path}"
  if ! litestream restore -config "$CONFIG_PATH" -if-replica-exists "$db_path"; then
    echo "[ERROR] Restore failed for ${name}. Set LITESTREAM_INIT_MODE=true only for first initialization."
    exit 1
  fi

  if [ ! -f "$db_path" ]; then
    echo "[ERROR] Replica not found for ${name}. Startup blocked to avoid data loss."
    echo "        First deploy: set LITESTREAM_INIT_MODE=true, initialize app, then set false."
    exit 1
  fi
}

case ",$REPLICATE_DBS," in
  *,tinyauth,*) restore_db "tinyauth" "/data/tinyauth/${TINYAUTH_DB_FILE:-tinyauth.db}" ;;
esac

case ",$REPLICATE_DBS," in
  *,app,*) restore_db "app" "/data/app/${LITESTREAM_APP_DB_FILE:-app.db}" ;;
esac

if [ "${1:-}" = "restore-only" ]; then
  echo "[RESTORE] Completed for: ${REPLICATE_DBS}"
  exit 0
fi

echo "[REPLICATE] Litestream watching: ${REPLICATE_DBS}"
exec litestream replicate -config "$CONFIG_PATH"
```

### `docs/services/tinyauth.md`
```text
# Tinyauth service (`docker-compose/compose.auth.yml`)

## Vai trò
- Là lớp xác thực chung cho các route Caddy qua `forward_auth`.
- Thay thế toàn bộ Caddy Basic Auth cũ.
- Dùng được cho app chính, ops services, deploy-code và app bổ sung sau này.

## Compose layer
- File: `docker-compose/compose.auth.yml`.
- `dc.sh` nạp layer này ngay sau `compose.core.yml` và trước ops/access/app.
- Service `tinyauth` không dùng `env_file`; compose chỉ map các biến Tinyauth v5 hợp lệ vào container để tránh container đọc nhầm biến template/deprecated.

## Cấu hình chính
- Service: `tinyauth`
- Container: `tinyauth`
- Image: `ghcr.io/steveiliop56/tinyauth:v5`
- Network: `app_net`
- Data volume: `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tinyauth:/data`
- DB runtime: `/data/${TINYAUTH_DB_FILE}`
- Public auth URL: `https://auth.${DOMAIN}`

Các label Caddy vẫn dùng `http://...` vì Cloudflared/Tailscale terminate HTTPS rồi proxy HTTP nội bộ vào Caddy. `TINYAUTH_APP_URL` phải là URL HTTPS public để cookie/redirect đúng scheme.

## Caddy integration
Các service cần bảo vệ thêm labels:

```yaml
- "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
- "caddy.forward_auth.uri=/api/auth/caddy"
- "caddy.forward_auth.header_up=X-Forwarded-Proto https"
- "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
```

Giữ label `reverse_proxy` của service như cũ. Header `X-Forwarded-Proto https` giúp Tinyauth nhìn đúng scheme public khi request đi qua Cloudflared/Tailscale vào Caddy bằng HTTP nội bộ.

## ENV cần thiết
- `TINYAUTH_APP_URL`: public URL của Tinyauth, ví dụ `https://auth.${DOMAIN}`.
- `TINYAUTH_PORT`: port nội bộ Tinyauth, mặc định `3000`.
- `TINYAUTH_DB_FILE`: tên file SQLite trong volume Tinyauth, mặc định `tinyauth.db`.
- `TINYAUTH_USERS`: users tĩnh, comma-separated, bắt buộc dùng bcrypt: `username:bcrypt_hash[:totp]`.
- `TINYAUTH_COOKIE_SECURE`: `true|false`, giữ `true` khi đi qua HTTPS tunnel.
- `TINYAUTH_TRUSTED_PROXIES`: danh sách IP/CIDR của proxy tin cậy, mặc định nên gồm private Docker ranges.
- `TINYAUTH_LOG_LEVEL`: `trace|debug|info|warn|error`.

Mapping runtime v5:
- `TINYAUTH_APP_URL` -> `TINYAUTH_APPURL`
- `TINYAUTH_USERS` -> `TINYAUTH_AUTH_USERS`
- `TINYAUTH_COOKIE_SECURE` -> `TINYAUTH_AUTH_SECURECOOKIE`
- `TINYAUTH_TRUSTED_PROXIES` -> `TINYAUTH_AUTH_TRUSTEDPROXIES`
- `TINYAUTH_DB_FILE` -> `TINYAUTH_DATABASE_PATH=/data/<file>`

## Tạo bcrypt user

```bash
docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --interactive
```

Chọn tùy chọn `format for Docker`, rồi đưa output vào `TINYAUTH_USERS`. Không dùng plain password như `admin:changeme`.

## OAuth ENV phổ biến
- `TINYAUTH_OAUTH_AUTO_REDIRECT`: `none`, `github`, `google`, `generic`, hoặc provider id khác.
- `TINYAUTH_OAUTH_WHITELIST`: whitelist email/domain/regex cho OAuth.
- Google:
  - `TINYAUTH_GOOGLE_CLIENT_ID`
  - `TINYAUTH_GOOGLE_CLIENT_SECRET`
  - Console: https://console.cloud.google.com/apis/credentials
- GitHub:
  - `TINYAUTH_GITHUB_CLIENT_ID`
  - `TINYAUTH_GITHUB_CLIENT_SECRET`
  - OAuth Apps: https://github.com/settings/developers
- Generic OAuth/OIDC:
  - `TINYAUTH_GENERIC_CLIENT_ID`
  - `TINYAUTH_GENERIC_CLIENT_SECRET`
  - `TINYAUTH_GENERIC_AUTH_URL`
  - `TINYAUTH_GENERIC_TOKEN_URL`
  - `TINYAUTH_GENERIC_USER_INFO_URL`
  - `TINYAUTH_GENERIC_SCOPES`
  - `TINYAUTH_GENERIC_REDIRECT_URL`
  - `TINYAUTH_GENERIC_NAME`

## Quy trình triển khai
1. Điền `TINYAUTH_APP_URL` bằng URL HTTPS public.
2. Generate bcrypt user riêng cho deployment và cập nhật `TINYAUTH_USERS`.
3. Giữ `TINYAUTH_COOKIE_SECURE=true` và cấu hình `TINYAUTH_TRUSTED_PROXIES`.
4. Đảm bảo `LITESTREAM_REPLICATE_DBS` có `tinyauth` nếu muốn backup DB auth.
5. Lần đầu deploy: `LITESTREAM_INIT_MODE=true`.
6. Sau khi login/config ổn: đổi `LITESTREAM_INIT_MODE=false` để các lần deploy sau bắt buộc restore.
7. Chạy: `bash docker-compose/scripts/dc.sh up -d --build --remove-orphans`.

## Vận hành
- Logs: `bash docker-compose/scripts/dc.sh logs -f tinyauth`.
- Restart: `bash docker-compose/scripts/dc.sh restart tinyauth`.
- DB nằm ở `${DOCKER_VOLUMES_ROOT}/tinyauth/${TINYAUTH_DB_FILE}`.
- Không xóa DB local khi `LITESTREAM_INIT_MODE=false` nếu chưa chắc replica S3 restore được.

## Legacy cần bỏ
- `TINYAUTH_SECRET`
- `TINYAUTH_DISABLE_CONTINUE`
- `TINYAUTH_TRUST_PROXY`
- `TINYAUTH_ALLOWED_USERS`
- `TINYAUTH_ALLOWED_DOMAINS`
- `TINYAUTH_ALLOWED_GROUPS`
- `TINYAUTH_OIDC_ISSUER`, `TINYAUTH_OIDC_CLIENT_ID`, `TINYAUTH_OIDC_CLIENT_SECRET`, `TINYAUTH_OIDC_SCOPES`
```

### `docs/services/litestream.md`
```text
# Litestream services (`docker-compose/compose.auth.yml`)

## Vai trò
- Backup/replicate SQLite DB lên S3-compatible storage.
- Hỗ trợ nhiều app, mỗi app dùng file SQLite và S3 path riêng.
- Bảo vệ dữ liệu bằng restore bắt buộc trước khi app chạy ở mode deploy bình thường.

## Compose layer
- File: `docker-compose/compose.auth.yml`.
- `dc.sh` nạp layer này ngay sau `compose.core.yml` và trước ops/access/app.
- Các project sau nên giữ auth/backup layer riêng, không nhúng Tinyauth/Litestream vào `compose.apps.yml`.

## Services
### `litestream-restore`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy one-shot trước `tinyauth` và `app`.
- Command: `/entrypoint.sh restore-only`.
- Nếu `LITESTREAM_INIT_MODE=false`, restore DB từ replica S3 rồi mới cho app chạy.
- Nếu restore lỗi hoặc không có replica, exit `1` để chặn app khởi động.

### `litestream`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy nền `litestream replicate` sau khi restore thành công.
- Dùng cùng config `services/litestream/litestream.yml`.

## File cấu hình
- `services/litestream/litestream.yml`: khai báo danh sách SQLite DB.
- `services/litestream/entrypoint.sh`: logic init/restore/replicate.

DB hiện có:
- Tinyauth: `/data/tinyauth/${TINYAUTH_DB_FILE}` → `${LITESTREAM_TINYAUTH_S3_PATH}`.
- App mẫu: `/data/app/${LITESTREAM_APP_DB_FILE}` → `${LITESTREAM_APP_S3_PATH}`.

## ENV bắt buộc
- `ENABLE_LITESTREAM`: `true|false`, bật profile Litestream trong `dc.sh`.
- `LITESTREAM_INIT_MODE`: `true|false`.
- `LITESTREAM_REPLICATE_DBS`: danh sách DB, ví dụ `tinyauth` hoặc `tinyauth,app`.
- `LITESTREAM_S3_ENDPOINT`: endpoint S3-compatible.
- `LITESTREAM_S3_BUCKET`: bucket chứa replica.
- `LITESTREAM_S3_ACCESS_KEY_ID`: access key.
- `LITESTREAM_S3_SECRET_ACCESS_KEY`: secret key.

## ENV per DB
- `LITESTREAM_TINYAUTH_S3_PATH`: object prefix/path cho DB Tinyauth.
- `LITESTREAM_APP_DB_FILE`: tên SQLite file app mẫu.
- `LITESTREAM_APP_S3_PATH`: object prefix/path cho DB app mẫu.

## ENV tuning
- `LITESTREAM_SYNC_INTERVAL`: default `5s`, giảm mất dữ liệu tối đa khi crash.
- `LITESTREAM_SNAPSHOT_INTERVAL`: default `30m`, giảm thời gian replay WAL khi restore.
- `LITESTREAM_RETENTION`: default `48h`, giữ generation cũ trong 48 giờ.
- `LITESTREAM_RETENTION_CHECK_INTERVAL`: default `1h`.

## Cách thêm SQLite DB cho app mới
1. Mount data app vào container app và Litestream cùng một host path:

```yaml
volumes:
  - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/myapp:/data/myapp
```

2. Thêm DB vào `services/litestream/litestream.yml`:

```yaml
  - path: /data/myapp/${LITESTREAM_MYAPP_DB_FILE}
    replicas:
      - type: s3
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_MYAPP_S3_PATH}
        access-key-id: ${LITESTREAM_S3_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_S3_SECRET_ACCESS_KEY}
        sync-interval: ${LITESTREAM_SYNC_INTERVAL}
        snapshot-interval: ${LITESTREAM_SNAPSHOT_INTERVAL}
        retention: ${LITESTREAM_RETENTION}
        retention-check-interval: ${LITESTREAM_RETENTION_CHECK_INTERVAL}
```

3. Thêm env vào `.env.example` và `.env`:

```env
LITESTREAM_MYAPP_DB_FILE=myapp.db
LITESTREAM_MYAPP_S3_PATH=myapp/myapp.db
LITESTREAM_REPLICATE_DBS=tinyauth,myapp
```

4. Cập nhật `services/litestream/entrypoint.sh` để restore DB mới trước khi app chạy.
5. Nếu app cần restore trước khi start, thêm `depends_on.litestream-restore.condition=service_completed_successfully`.

## Quy trình triển khai an toàn
### Lần đầu tạo DB mới
1. Set `LITESTREAM_INIT_MODE=true`.
2. Deploy stack.
3. Truy cập app/Tinyauth để tạo dữ liệu ban đầu.
4. Kiểm tra `litestream` đang replicate.
5. Đổi `LITESTREAM_INIT_MODE=false`.

### Các lần deploy bình thường
1. Giữ `LITESTREAM_INIT_MODE=false`.
2. `litestream-restore` bắt buộc restore replica trước.
3. Nếu không có backup hoặc restore lỗi, app không chạy để tránh tạo DB rỗng.

## Vận hành
- Config check: `bash docker-compose/scripts/dc.sh config`.
- Logs restore/replicate: `bash docker-compose/scripts/dc.sh logs -f litestream litestream-restore`.
- Kiểm tra container: `bash docker-compose/scripts/dc.sh ps`.
- Không chạy `down -v` nếu chưa chắc replica S3 đã ổn.
```

### `docs/services/rclone.md`
```text
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
```
<!-- END:EMBEDDED_FILES -->
