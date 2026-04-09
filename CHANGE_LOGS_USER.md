# CHANGE LOGS (User-facing)

---

## [2.0.0] — 2026-04-09 — Modular Stack Template

### What's New

**Deploy any Docker image in minutes**
Change two lines in `.env` (`APP_IMAGE` and `APP_PORT`) and your app is live — no YAML editing required.

**Feature flags — enable what you need**
Turn ops tools on or off with simple env vars:
```env
ENABLE_DOZZLE=true
ENABLE_FILEBROWSER=true
ENABLE_WEBSSH=false
ENABLE_TAILSCALE=false
```

**Subdomains auto-generated**
Set `PROJECT_NAME=gitea` and `DOMAIN=example.com` once. All service URLs follow automatically:
- `gitea.example.com` → your app
- `logs.gitea.example.com` → log viewer
- `files.gitea.example.com` → file manager
- `ttyd.gitea.example.com` → web terminal

**One-command validation before deploy**
```bash
npm run validate
```
Checks env vars, Cloudflare DNS records, Tailscale key format, and compose YAML — all at once.

**One-command deploy**
```bash
npm run up
```

### What Changed (migration from v1)

If upgrading from the previous `docker-compose.yml` setup:

1. Replace `SUBDOMAIN_APP/DOZZLE/FILEBROWSER/WEBSSH` with just `PROJECT_NAME`
2. Replace `TAILSCALE_CLIENT_SECRET` with `TS_AUTHKEY`
3. Replace `docker compose up` with `bash dc.sh up` or `npm run up`
4. Run `npm run gen:cf-config` to regenerate your `cloudflared/config.yml`

See `docs/DEPLOY.md` for the full migration guide.

---
