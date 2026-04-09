#!/usr/bin/env node
// ================================================================
//  scripts/validate-cf.js
//  Checks Cloudflare DNS records for all expected subdomains.
//
//  Requires in .env:
//    CF_API_TOKEN, CF_ZONE_ID, PROJECT_NAME, DOMAIN
//    ENABLE_DOZZLE, ENABLE_FILEBROWSER, ENABLE_WEBSSH (optional)
// ================================================================
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Load .env ─────────────────────────────────────────────────────
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = parseEnvFile(path.resolve(process.cwd(), '.env'));

const CF_API_TOKEN = process.env.CF_API_TOKEN || env.CF_API_TOKEN;
const CF_ZONE_ID   = process.env.CF_ZONE_ID   || env.CF_ZONE_ID;
const PROJECT_NAME = env.PROJECT_NAME;
const DOMAIN       = env.DOMAIN;

if (!CF_API_TOKEN || !CF_ZONE_ID) {
  console.warn('⚠️  CF_API_TOKEN or CF_ZONE_ID not set → skipping Cloudflare DNS check.');
  console.warn('   Set them in .env to enable this validation.');
  process.exit(0);
}

if (!PROJECT_NAME || !DOMAIN) {
  console.error('❌  PROJECT_NAME and DOMAIN must be set in .env');
  process.exit(1);
}

// ── Build list of expected hostnames ─────────────────────────────
const expectedHosts = [`${PROJECT_NAME}.${DOMAIN}`];
if (env.ENABLE_DOZZLE      !== 'false') expectedHosts.push(`logs.${PROJECT_NAME}.${DOMAIN}`);
if (env.ENABLE_FILEBROWSER !== 'false') expectedHosts.push(`files.${PROJECT_NAME}.${DOMAIN}`);
if (env.ENABLE_WEBSSH      !== 'false') expectedHosts.push(`ttyd.${PROJECT_NAME}.${DOMAIN}`);

console.log(`\n🌐  Cloudflare DNS Validation`);
console.log(`    Zone ID : ${CF_ZONE_ID}`);
console.log(`    Domain  : ${DOMAIN}`);
console.log(`    Checking ${expectedHosts.length} hostname(s):\n`);
expectedHosts.forEach(h => console.log(`    • ${h}`));
console.log();

// ── CF API call ───────────────────────────────────────────────────
function cfRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method : 'GET',
      headers : {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type' : 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // Verify token is valid
  let tokenCheck;
  try {
    tokenCheck = await cfRequest('/user/tokens/verify');
  } catch (e) {
    console.error(`❌  Cannot reach Cloudflare API: ${e.message}`);
    process.exit(1);
  }

  if (!tokenCheck.success) {
    console.error('❌  CF_API_TOKEN is invalid or expired:');
    (tokenCheck.errors || []).forEach(e => console.error(`    ${e.message}`));
    process.exit(1);
  }
  console.log('✅  API token is valid\n');

  // Fetch all DNS records for the zone
  let records;
  try {
    const res = await cfRequest(`/zones/${CF_ZONE_ID}/dns_records?per_page=200`);
    if (!res.success) {
      console.error('❌  Failed to list DNS records:');
      (res.errors || []).forEach(e => console.error(`    ${e.message}`));
      process.exit(1);
    }
    records = res.result;
  } catch (e) {
    console.error(`❌  Error fetching DNS records: ${e.message}`);
    process.exit(1);
  }

  console.log(`    Found ${records.length} DNS record(s) in zone.\n`);

  // ── Check each expected hostname ─────────────────────────────
  const missing  = [];
  const found    = [];

  for (const hostname of expectedHosts) {
    const match = records.find(r => r.name === hostname);
    if (!match) {
      missing.push(hostname);
    } else {
      const tunnelLike = match.type === 'CNAME' && match.content.endsWith('.cfargotunnel.com');
      const status = tunnelLike
        ? `✅  CNAME → ${match.content}`
        : `⚠️  ${match.type} → ${match.content} (expected CNAME to *.cfargotunnel.com)`;
      found.push({ hostname, status });
    }
  }

  if (found.length) {
    console.log('📋  Records found:');
    found.forEach(({ hostname, status }) => {
      console.log(`    ${hostname}`);
      console.log(`      ${status}`);
    });
    console.log();
  }

  if (missing.length) {
    console.log('❌  Missing DNS records (create in Cloudflare dashboard):');
    missing.forEach(h => {
      console.log(`    ${h}`);
      console.log(`      Type: CNAME`);
      console.log(`      Target: <your-tunnel-id>.cfargotunnel.com`);
      console.log(`      Proxy: ✅ (orange cloud on)`);
    });
    console.log('\n→  Go to: https://dash.cloudflare.com → your domain → DNS → Add record\n');
    process.exit(1);
  }

  console.log('✅  All expected DNS records are present!\n');
}

main().catch(e => {
  console.error(`❌  Unexpected error: ${e.message}`);
  process.exit(1);
});
