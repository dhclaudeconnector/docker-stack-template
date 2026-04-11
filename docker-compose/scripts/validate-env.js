#!/usr/bin/env node
// ================================================================
//  docker-compose/scripts/validate-env.js
//  Validates .env completeness and value sanity before deploying.
//
//  Exit codes:
//    0 — all good (warnings allowed)
//    1 — one or more errors
// ================================================================
"use strict";

const fs = require("fs");
const path = require("path");

// ── Load .env ─────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌  .env file not found.");
  console.error("    Run: cp .env.example .env  then fill in values.");
  process.exit(1);
}

/** Parse key=value lines, skip comments and blanks */
function parseEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const env = parseEnvFile(envPath);

const errors = [];
const warnings = [];
const ok = [];

function resolveRefs(value, source = env) {
  let out = value;
  let changed = true;

  while (changed) {
    changed = false;
    out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
      if (!(key in source)) return `\${${key}}`;
      changed = true;
      return source[key];
    });
  }

  return out;
}

function isValidHttpsJsonUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

// ── Helper ───────────────────────────────────────────────────────
function check(key, { required = true, desc = "", validate, display } = {}) {
  const val = env[key];
  if (!val) {
    if (required) errors.push(`Missing ${key}${desc ? "  →  " + desc : ""}`);
    else warnings.push(`${key} not set — ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(val);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  // Mask secrets
  const secret = ["TOKEN", "HASH", "KEY", "SECRET", "PASSWORD"].some((k) => key.includes(k));
  const shown = display ? display(val) : val;
  ok.push(`${key} = ${secret ? shown.slice(0, 6) + "***" : shown}`);
}

// ── Required core vars ────────────────────────────────────────────
check("STACK_NAME", {
  desc: "Docker network prefix + Tailscale hostname",
  validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "Use only lowercase a-z, 0-9, hyphens. No spaces."),
});

check("PROJECT_NAME", {
  desc: "Subdomain prefix: ${PROJECT_NAME}.${DOMAIN}",
  validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "Use only lowercase a-z, 0-9, hyphens."),
});

check("DOMAIN", {
  desc: "Root domain, e.g. example.com",
  validate: (v) => {
    if (v.startsWith("http")) return "Should not include http:// or https://";
    if (v.endsWith("/")) return "Should not have trailing slash";
    if (!v.includes(".")) return "Does not look like a valid domain";
    return null;
  },
});

check("CADDY_EMAIL", {
  desc: "SSL certificate registration email",
  validate: (v) => (v.includes("@") ? null : "Does not look like a valid email"),
});

check("CADDY_AUTH_USER", { desc: "Basic auth username" });

check("CADDY_AUTH_HASH", {
  desc: 'Bcrypt hash — generate with: docker run --rm caddy:alpine caddy hash-password --plaintext "pw"',
  validate: (v) => {
    const h = v.replace(/\$\$/g, "$");
    if (!h.startsWith("$2a$") && !h.startsWith("$2b$")) {
      return "Should start with $2a$ or $2b$ (bcrypt format). In .env, store it exactly as generated, preferably wrapped in single quotes.";
    }
    return null;
  },
});

// ── Application vars ──────────────────────────────────────────────
check("APP_PORT", {
  desc: "Port app listens on inside container",
  validate: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return `"${v}" is not a valid port number`;
    return null;
  },
});

check("APP_HOST_PORT", {
  required: false,
  desc: "Localhost port published for direct browser access",
  validate: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return `"${v}" is not a valid port number`;
    return null;
  },
});

const appDockerfile = path.resolve(process.cwd(), "services/app/Dockerfile");
if (!fs.existsSync(appDockerfile)) {
  errors.push("services/app/Dockerfile not found — app service build will fail");
} else {
  ok.push("services/app/Dockerfile  ✓  present");
}

// ── Cloudflare ─────────────────────────────────────────────────────
// Check credentials file presence
const credFile = path.resolve(process.cwd(), "cloudflared/credentials.json");
const legacyCredFile = path.resolve(process.cwd(), "cloudflared-credentials.json");
if (!fs.existsSync(credFile)) {
  if (fs.existsSync(legacyCredFile)) {
    warnings.push("Found legacy cloudflared-credentials.json in repo root — move it to cloudflared/credentials.json for the current compose setup.");
  } else {
    warnings.push("cloudflared/credentials.json not found — tunnel will fail at runtime");
  }
} else {
  ok.push("cloudflared/credentials.json  ✓  present");
}

const cfConfig = path.resolve(process.cwd(), "cloudflared/config.yml");
if (!fs.existsSync(cfConfig)) {
  errors.push("cloudflared/config.yml not found — copy from cloudflared/config.yml.example");
} else {
  ok.push("cloudflared/config.yml  ✓  present");
}

// ── Tailscale (conditional) ───────────────────────────────────────
if (env.ENABLE_TAILSCALE === "true") {
  check("TAILSCALE_AUTHKEY", {
    required: false,
    desc: "Auth key for Tailscale node join (tskey-auth-... or tskey-client-...)",
    validate: (v) => {
      if (!v.startsWith("tskey-")) return 'Should start with "tskey-"';
      if (v.length < 40) warnings.push("TAILSCALE_AUTHKEY: unusually short — double-check the value");
      return null;
    },
  });

  if (!env.TAILSCALE_AUTHKEY) {
    warnings.push("TAILSCALE_AUTHKEY not set — Tailscale node join may fail on fresh state.");
  }

  check("TAILSCALE_OAUTH_SECRET", {
    required: false,
    desc: "Optional OAuth client secret for tailscale-init / keep-ip API actions (tskey-client-...)",
    validate: (v) => {
      if (!v.startsWith("tskey-client-")) return 'Should start with "tskey-client-"';
      if (v.length < 40) warnings.push("TAILSCALE_OAUTH_SECRET: unusually short — double-check the value");
      return null;
    },
  });

  check("TAILSCALE_TAGS", {
    required: false,
    desc: "Comma-separated tags, e.g. tag:ci,tag:container",
    validate: (v) => {
      if (/\s/.test(v)) return "Must not contain spaces. Use format: tag:ci,tag:container";
      if (!/^tag:[A-Za-z0-9][A-Za-z0-9_-]*(,tag:[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(v)) {
        return "Invalid format. Use comma-separated tags: tag:ci,tag:container";
      }
      return null;
    },
  });

  const keepIpRaw = (env.TAILSCALE_KEEP_IP_ENABLE || "false").trim().toLowerCase();
  if (env.TAILSCALE_KEEP_IP_ENABLE && keepIpRaw !== "true" && keepIpRaw !== "false") {
    errors.push('TAILSCALE_KEEP_IP_ENABLE must be exactly "true" or "false"');
  }

  if (keepIpRaw === "true") {
    check("TAILSCALE_KEEP_IP_FIREBASE_URL", {
      desc: "Firebase Realtime DB .json URL used to backup tailscaled.state",
      validate: (v) => (isValidHttpsJsonUrl(v) ? null : "Must be https URL ending with .json"),
      display: (v) => {
        try {
          const u = new URL(v);
          const redacted = u.search ? "?***" : "";
          return `${u.origin}${u.pathname}${redacted}`;
        } catch {
          return "<invalid-url>";
        }
      },
    });

    check("TAILSCALE_KEEP_IP_INTERVAL_SEC", {
      required: false,
      desc: "Backup interval in seconds",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 5) return "Must be an integer >= 5";
        return null;
      },
    });

    if (!env.TAILSCALE_CLIENDID && !env.TAILSCALE_CLIENTID) {
      errors.push("TAILSCALE_KEEP_IP_ENABLE=true requires TAILSCALE_CLIENDID (or TAILSCALE_CLIENTID) for OAuth token.");
    }
    const oauthForKeepIp = (env.TAILSCALE_OAUTH_SECRET || env.TAILSCALE_AUTHKEY || "").trim();
    if (!env.TAILSCALE_OAUTH_SECRET) {
      warnings.push("TAILSCALE_KEEP_IP_ENABLE=true and TAILSCALE_OAUTH_SECRET is empty — using TAILSCALE_AUTHKEY fallback.");
    }
    if (!oauthForKeepIp) {
      errors.push("TAILSCALE_KEEP_IP_ENABLE=true requires TAILSCALE_OAUTH_SECRET (or TAILSCALE_AUTHKEY fallback) for API cleanup.");
    } else if (!oauthForKeepIp.startsWith("tskey-client-")) {
      errors.push("TAILSCALE_KEEP_IP_ENABLE=true requires OAuth secret format tskey-client-... in TAILSCALE_OAUTH_SECRET (or TAILSCALE_AUTHKEY fallback).");
    }
  }

  ok.push(
    `TAILSCALE_INTERNAL_HOST = ${resolveRefs(`${env.STACK_NAME || "mystack"}.${env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local"}`)}`
  );
} else {
  ok.push("ENABLE_TAILSCALE = false  (Tailscale skipped)");
}

// ── Feature flags sanity ──────────────────────────────────────────
const flags = ["ENABLE_DOZZLE", "ENABLE_FILEBROWSER", "ENABLE_WEBSSH", "ENABLE_TAILSCALE"];
for (const flag of flags) {
  const val = env[flag];
  if (val && val !== "true" && val !== "false") {
    errors.push(`${flag}="${val}" — must be exactly "true" or "false"`);
  }
}

// ── Subdomain preview ─────────────────────────────────────────────
if (env.PROJECT_NAME && env.DOMAIN) {
  const p = env.PROJECT_NAME;
  const d = env.DOMAIN;
  const tailHost = resolveRefs(`${env.STACK_NAME || "mystack"}.${env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local"}`);
  const preview = [
    `  app    → http://${resolveRefs(env.CLOUDFLARED_TUNNEL_HOSTNAME_1 || `${p}.${d}`)}`,
    env.ENABLE_DOZZLE !== "false" ? `  dozzle → http://${resolveRefs(env.CLOUDFLARED_TUNNEL_HOSTNAME_3 || `logs.${p}.${d}`)}` : null,
    env.ENABLE_FILEBROWSER !== "false" ? `  files  → http://${resolveRefs(env.CLOUDFLARED_TUNNEL_HOSTNAME_4 || `files.${p}.${d}`)}` : null,
    env.ENABLE_WEBSSH !== "false" ? `  ssh    → http://${resolveRefs(env.CLOUDFLARED_TUNNEL_HOSTNAME_2 || `ttyd.${p}.${d}`)}` : null,
    env.ENABLE_TAILSCALE === "true" ? `  tail   → https://${tailHost}` : null,
  ].filter(Boolean);
  ok.push("\n  📡 Generated subdomains:\n" + preview.join("\n"));
}

// ── Print report ──────────────────────────────────────────────────
const hr = "─".repeat(55);
console.log(`\n📋  ENV VALIDATION REPORT`);
console.log(hr);

if (ok.length) {
  console.log(`\n✅  Valid (${ok.length}):`);
  ok.forEach((s) => console.log(`    ${s}`));
}
if (warnings.length) {
  console.log(`\n⚠️   Warnings (${warnings.length}):`);
  warnings.forEach((s) => console.log(`    ${s}`));
}
if (errors.length) {
  console.log(`\n❌  Errors (${errors.length}):`);
  errors.forEach((s) => console.log(`    ${s}`));
  console.log(`\n→  Fix errors above before deploying.\n`);
  process.exit(1);
}

console.log(`\n✅  All required variables are valid!`);
if (warnings.length) console.log(`⚠️   Review ${warnings.length} warning(s) above.`);
console.log();
