#!/usr/bin/env node
// ================================================================
//  scripts/validate-env.js
//  Validates .env completeness and value sanity before deploying.
//
//  Exit codes:
//    0 — all good (warnings allowed)
//    1 — one or more errors
// ================================================================
'use strict';

const fs   = require('fs');
const path = require('path');

// ── Load .env ─────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('❌  .env file not found.');
  console.error('    Run: cp .env.example .env  then fill in values.');
  process.exit(1);
}

/** Parse key=value lines, skip comments and blanks */
function parseEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = val;
  }
  return env;
}

const env = parseEnvFile(envPath);

const errors   = [];
const warnings = [];
const ok       = [];

// ── Helper ───────────────────────────────────────────────────────
function check(key, { required = true, desc = '', validate } = {}) {
  const val = env[key];
  if (!val) {
    if (required) errors.push(`Missing ${key}${desc ? '  →  ' + desc : ''}`);
    else warnings.push(`${key} not set — ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(val);
    if (msg) { errors.push(`${key}: ${msg}`); return; }
  }
  // Mask secrets
  const secret = ['TOKEN','HASH','KEY','SECRET','PASSWORD'].some(k => key.includes(k));
  ok.push(`${key} = ${secret ? val.slice(0,6) + '***' : val}`);
}

// ── Required core vars ────────────────────────────────────────────
check('STACK_NAME', {
  desc: 'Docker network prefix + Tailscale hostname',
  validate: v => /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'Use only lowercase a-z, 0-9, hyphens. No spaces.',
});

check('PROJECT_NAME', {
  desc: 'Subdomain prefix: ${PROJECT_NAME}.${DOMAIN}',
  validate: v => /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'Use only lowercase a-z, 0-9, hyphens.',
});

check('DOMAIN', {
  desc: 'Root domain, e.g. example.com',
  validate: v => {
    if (v.startsWith('http')) return 'Should not include http:// or https://';
    if (v.endsWith('/'))     return 'Should not have trailing slash';
    if (!v.includes('.'))    return 'Does not look like a valid domain';
    return null;
  },
});

check('CADDY_EMAIL', {
  desc: 'SSL certificate registration email',
  validate: v => v.includes('@') ? null : 'Does not look like a valid email',
});

check('CADDY_AUTH_USER', { desc: 'Basic auth username' });

check('CADDY_AUTH_HASH', {
  desc: 'Bcrypt hash — generate with: docker run --rm caddy:alpine caddy hash-password --plaintext "pw"',
  validate: v => {
    const h = v.replace(/\$\$/g, '$');
    if (!h.startsWith('$2a$') && !h.startsWith('$2b$')) {
      return 'Should start with $2a$ or $2b$ (bcrypt format). Check escaping in .env (use $$ not $).';
    }
    return null;
  },
});

// ── Application vars ──────────────────────────────────────────────
check('APP_IMAGE', {
  desc: 'Docker image, e.g. gitea/gitea:1.21 or node:20-alpine',
  validate: v => {
    if (v === 'node:20-alpine') warnings.push('APP_IMAGE is still the default placeholder. Set your real image.');
    return null;
  },
});

check('APP_PORT', {
  desc: 'Port app listens on inside container',
  validate: v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return `"${v}" is not a valid port number`;
    return null;
  },
});

// ── Cloudflare ─────────────────────────────────────────────────────
check('CF_API_TOKEN', {
  required: false,
  desc: 'Cloudflare API token (needed for validate:cf DNS check)',
});
check('CF_ZONE_ID', {
  required: false,
  desc: 'Cloudflare Zone ID (needed for validate:cf DNS check)',
});

// Check credentials file presence
const credFile = path.resolve(process.cwd(), 'cloudflared-credentials.json');
if (!fs.existsSync(credFile)) {
  warnings.push('cloudflared-credentials.json not found — tunnel will fail at runtime');
} else {
  ok.push('cloudflared-credentials.json  ✓  present');
}

const cfConfig = path.resolve(process.cwd(), 'cloudflared/config.yml');
if (!fs.existsSync(cfConfig)) {
  errors.push('cloudflared/config.yml not found — copy from cloudflared/config.yml.example');
} else {
  ok.push('cloudflared/config.yml  ✓  present');
}

// ── Tailscale (conditional) ───────────────────────────────────────
if (env.ENABLE_TAILSCALE === 'true') {
  check('TS_AUTHKEY', {
    desc: 'Tailscale auth key from https://login.tailscale.com/admin/settings/keys',
    validate: v => {
      if (!v.startsWith('tskey-')) return 'Should start with "tskey-" — verify the key format';
      if (!v.startsWith('tskey-auth-')) warnings.push('TS_AUTHKEY: expected "tskey-auth-" prefix for auth keys');
      if (v.length < 40) warnings.push('TS_AUTHKEY: unusually short — double-check the value');
      return null;
    },
  });
} else {
  ok.push('ENABLE_TAILSCALE = false  (Tailscale skipped)');
}

// ── Feature flags sanity ──────────────────────────────────────────
const flags = ['ENABLE_DOZZLE','ENABLE_FILEBROWSER','ENABLE_WEBSSH','ENABLE_TAILSCALE'];
for (const flag of flags) {
  const val = env[flag];
  if (val && val !== 'true' && val !== 'false') {
    errors.push(`${flag}="${val}" — must be exactly "true" or "false"`);
  }
}

// ── Subdomain preview ─────────────────────────────────────────────
if (env.PROJECT_NAME && env.DOMAIN) {
  const p = env.PROJECT_NAME;
  const d = env.DOMAIN;
  const preview = [
    `  app    → http://${p}.${d}`,
    env.ENABLE_DOZZLE      !== 'false' ? `  dozzle → http://logs.${p}.${d}`  : null,
    env.ENABLE_FILEBROWSER !== 'false' ? `  files  → http://files.${p}.${d}` : null,
    env.ENABLE_WEBSSH      !== 'false' ? `  ssh    → http://ttyd.${p}.${d}`  : null,
  ].filter(Boolean);
  ok.push('\n  📡 Generated subdomains:\n' + preview.join('\n'));
}

// ── Print report ──────────────────────────────────────────────────
const hr = '─'.repeat(55);
console.log(`\n📋  ENV VALIDATION REPORT`);
console.log(hr);

if (ok.length) {
  console.log(`\n✅  Valid (${ok.length}):`);
  ok.forEach(s => console.log(`    ${s}`));
}
if (warnings.length) {
  console.log(`\n⚠️   Warnings (${warnings.length}):`);
  warnings.forEach(s => console.log(`    ${s}`));
}
if (errors.length) {
  console.log(`\n❌  Errors (${errors.length}):`);
  errors.forEach(s => console.log(`    ${s}`));
  console.log(`\n→  Fix errors above before deploying.\n`);
  process.exit(1);
}

console.log(`\n✅  All required variables are valid!`);
if (warnings.length) console.log(`⚠️   Review ${warnings.length} warning(s) above.`);
console.log();
