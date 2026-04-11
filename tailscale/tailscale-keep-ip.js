#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

// ================================================================
// tailscale/tailscale-keep-ip.js
// Modes:
//   prepare     - restore tailscaled.state from Firebase (base64),
//                 then remove existing machine(s) by STACK_NAME
//   backup-loop - periodically backup tailscaled.state to Firebase
//
// Environment:
//   TAILSCALE_KEEP_IP_ENABLE=true|false
//   TAILSCALE_KEEP_IP_FIREBASE_URL=<https://.../path.json?auth=...>
//   TAILSCALE_KEEP_IP_STATE_FILE=/var/lib/tailscale/tailscaled.state
//   TAILSCALE_KEEP_IP_INTERVAL_SEC=30
//   STACK_NAME=<hostname to keep>
//   TAILSCALE_TS_TAILNET=- (or TS_TAILNET)
//   TAILSCALE_CLIENDID + TAILSCALE_AUTHKEY
// ================================================================

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Base16(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeHostLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function shortHostnameFromValue(value) {
  const v = normalizeHostLabel(value);
  if (!v) return "";
  const first = v.split(".")[0];
  return first || v;
}

function pickDeviceId(device) {
  if (!device || typeof device !== "object") return "";
  return String(device.nodeId || device.id || device.deviceId || "").trim();
}

function collectDeviceHostCandidates(device) {
  if (!device || typeof device !== "object") return [];
  const values = [
    device.hostname,
    device.name,
    device.computedName,
    device.givenName,
    device.machineName,
    device.dnsName,
  ];

  const out = new Set();
  for (const raw of values) {
    const full = normalizeHostLabel(raw);
    if (!full) continue;
    out.add(full);
    const short = shortHostnameFromValue(full);
    if (short) out.add(short);
  }
  return [...out];
}

function apiRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const reqHeaders = { Accept: "application/json", ...(headers || {}) };
    if (body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            raw,
            body: json,
          });
        });
      },
    );

    req.on("error", reject);
    if (body !== undefined) req.write(payload);
    req.end();
  });
}

function apiRequestTailscale({ method, endpointPath, accessToken, body }) {
  return apiRequest({
    method,
    url: `https://api.tailscale.com/api/v2${endpointPath}`,
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  });
}

async function getOAuthAccessToken(clientId, clientSecret) {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.tailscale.com",
        port: 443,
        path: "/api/v2/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode || 0,
            body: json,
            raw,
          });
        });
      },
    );

    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

function isLikelyFirebaseUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return parsed.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function readStateFile(stateFilePath) {
  if (!fs.existsSync(stateFilePath)) return null;
  try {
    return fs.readFileSync(stateFilePath);
  } catch (err) {
    throw new Error(`cannot read state file ${stateFilePath}: ${err.message}`);
  }
}

function looksLikeTailscaleState(buffer) {
  if (!buffer || buffer.length < 3) return false;
  const text = buffer.toString("utf-8");
  if (!text || text[0] !== "{") return false;
  return text.includes("_machinekey") || text.includes("_profiles") || text.includes("profile-");
}

async function backupState({
  firebaseUrl,
  stateFilePath,
  hostname,
  tailnet,
  modeLabel,
  lastHashRef,
}) {
  const stateBuffer = readStateFile(stateFilePath);
  if (!stateBuffer || stateBuffer.length === 0) {
    console.log(`ℹ️  ${modeLabel}: state file not found yet: ${stateFilePath}`);
    return false;
  }
  if (!looksLikeTailscaleState(stateBuffer)) {
    console.log(`ℹ️  ${modeLabel}: state file looks incomplete (${stateBuffer.length} bytes), skip upload.`);
    return false;
  }

  const hash = sha256Base16(stateBuffer);
  if (lastHashRef.value && lastHashRef.value === hash) {
    return false;
  }

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    hostname,
    tailnet,
    sizeBytes: stateBuffer.length,
    sha256: hash,
    stateBase64: stateBuffer.toString("base64"),
  };

  const putRes = await apiRequest({
    method: "PUT",
    url: firebaseUrl,
    body: payload,
  });

  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`${modeLabel}: Firebase PUT failed (HTTP ${putRes.status})`);
  }

  lastHashRef.value = hash;
  console.log(`✅  ${modeLabel}: uploaded state (${stateBuffer.length} bytes, sha256=${hash.slice(0, 12)}...)`);
  return true;
}

async function restoreState({ firebaseUrl, stateFilePath }) {
  const getRes = await apiRequest({
    method: "GET",
    url: firebaseUrl,
  });

  if (getRes.status === 404) {
    console.log("ℹ️  restore: no backup found (404).");
    return false;
  }
  if (getRes.status < 200 || getRes.status >= 300) {
    throw new Error(`restore: Firebase GET failed (HTTP ${getRes.status})`);
  }

  const doc = getRes.body;
  if (!doc) {
    console.log("ℹ️  restore: backup document is empty.");
    return false;
  }

  const base64 = typeof doc === "string" ? doc : doc.stateBase64;
  if (!base64 || typeof base64 !== "string") {
    console.log("ℹ️  restore: no stateBase64 field found.");
    return false;
  }

  const data = Buffer.from(base64, "base64");
  if (!data.length) {
    console.log("ℹ️  restore: decoded state is empty.");
    return false;
  }
  if (!looksLikeTailscaleState(data)) {
    console.log(`ℹ️  restore: backup state looks incomplete (${data.length} bytes), skipping restore.`);
    return false;
  }

  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, data);
  console.log(`✅  restore: wrote ${stateFilePath} (${data.length} bytes)`);
  return true;
}

async function removeHostnameFromTailnet({ hostname, tailnet, authKey, clientId }) {
  if (!hostname) {
    console.log("⚠️  remove-hostname: STACK_NAME is empty, skipping.");
    return;
  }
  if (!authKey || !clientId) {
    console.log("⚠️  remove-hostname: missing TAILSCALE_AUTHKEY/TAILSCALE_CLIENDID, skipping.");
    return;
  }

  let accessToken = "";
  try {
    const tokenRes = await getOAuthAccessToken(clientId, authKey);
    if (tokenRes.status === 200 && tokenRes.body && tokenRes.body.access_token) {
      accessToken = tokenRes.body.access_token;
    } else {
      console.log(`⚠️  remove-hostname: OAuth token request failed (HTTP ${tokenRes.status}), skipping.`);
      return;
    }
  } catch (err) {
    console.log(`⚠️  remove-hostname: cannot get OAuth token (${err.message}), skipping.`);
    return;
  }

  const encodedTailnet = encodeURIComponent(tailnet || "-");
  const devicesRes = await apiRequestTailscale({
    method: "GET",
    endpointPath: `/tailnet/${encodedTailnet}/devices`,
    accessToken,
  });

  if (devicesRes.status !== 200) {
    console.log(`⚠️  remove-hostname: cannot list devices (HTTP ${devicesRes.status}), skipping.`);
    return;
  }

  const devices = Array.isArray(devicesRes.body?.devices)
    ? devicesRes.body.devices
    : Array.isArray(devicesRes.body)
      ? devicesRes.body
      : [];

  const target = normalizeHostLabel(hostname);
  const matched = devices.filter((d) => collectDeviceHostCandidates(d).includes(target));

  if (!matched.length) {
    console.log(`ℹ️  remove-hostname: no existing device matched "${hostname}".`);
    return;
  }

  let removed = 0;
  for (const device of matched) {
    const deviceId = pickDeviceId(device);
    if (!deviceId) continue;
    const delRes = await apiRequestTailscale({
      method: "DELETE",
      endpointPath: `/device/${encodeURIComponent(deviceId)}`,
      accessToken,
    });

    if ([200, 202, 204, 404].includes(delRes.status)) {
      removed += 1;
      continue;
    }
    console.log(`⚠️  remove-hostname: failed delete id=${deviceId} (HTTP ${delRes.status})`);
  }

  console.log(`✅  remove-hostname: processed ${removed}/${matched.length} matched device(s).`);
}

async function run() {
  const mode = (process.argv[2] || "prepare").trim().toLowerCase();
  const enabled = toBool(process.env.TAILSCALE_KEEP_IP_ENABLE, false);

  const firebaseUrl = (process.env.TAILSCALE_KEEP_IP_FIREBASE_URL || "").trim();
  const stateFilePath = (process.env.TAILSCALE_KEEP_IP_STATE_FILE || "/var/lib/tailscale/tailscaled.state").trim();
  const intervalSecRaw = (process.env.TAILSCALE_KEEP_IP_INTERVAL_SEC || "30").trim();
  const intervalSec = Number.isInteger(Number(intervalSecRaw)) ? Number(intervalSecRaw) : 30;
  const hostname = (process.env.STACK_NAME || "").trim();
  const tailnet = (process.env.TAILSCALE_TS_TAILNET || process.env.TS_TAILNET || "-").trim() || "-";
  const authKey = (process.env.TAILSCALE_AUTHKEY || "").trim();
  const clientId = (process.env.TAILSCALE_CLIENDID || process.env.TAILSCALE_CLIENTID || "").trim();

  console.log(`\n🔐  Tailscale Keep IP (${mode})`);
  console.log(`    enabled : ${enabled}`);
  console.log(`    state   : ${stateFilePath}`);
  console.log(`    host    : ${hostname || "(missing)"}`);
  console.log(`    tailnet : ${tailnet}\n`);

  if (!enabled) {
    console.log("ℹ️  TAILSCALE_KEEP_IP_ENABLE=false, skipping.\n");
    process.exit(0);
  }

  if (!isLikelyFirebaseUrl(firebaseUrl)) {
    console.error("❌  TAILSCALE_KEEP_IP_FIREBASE_URL is invalid or missing (must be https URL ending with .json).");
    process.exit(1);
  }

  if (mode === "prepare") {
    await restoreState({ firebaseUrl, stateFilePath });
    await removeHostnameFromTailnet({ hostname, tailnet, authKey, clientId });
    console.log("\n✅  prepare complete.\n");
    process.exit(0);
  }

  if (mode === "backup-once") {
    await backupState({
      firebaseUrl,
      stateFilePath,
      hostname,
      tailnet,
      modeLabel: "backup-once",
      lastHashRef: { value: "" },
    });
    console.log("\n✅  backup-once complete.\n");
    process.exit(0);
  }

  if (mode === "backup-loop") {
    const everyMs = Math.max(5, intervalSec) * 1000;
    const lastHashRef = { value: "" };
    console.log(`ℹ️  backup-loop: interval ${Math.max(5, intervalSec)}s`);

    let stopping = false;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`\nℹ️  received ${signal}, stopping backup-loop...`);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));

    while (!stopping) {
      try {
        await backupState({
          firebaseUrl,
          stateFilePath,
          hostname,
          tailnet,
          modeLabel: "backup-loop",
          lastHashRef,
        });
      } catch (err) {
        console.log(`⚠️  backup-loop: ${err.message}`);
      }
      await sleep(everyMs);
    }

    console.log("✅  backup-loop stopped.\n");
    process.exit(0);
  }

  console.error(`❌  Unknown mode: ${mode}`);
  console.error("    Use one of: prepare, backup-once, backup-loop");
  process.exit(1);
}

run().catch((err) => {
  console.error(`❌  Unexpected error: ${err.message}`);
  process.exit(1);
});
