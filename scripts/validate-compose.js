#!/usr/bin/env node
// ================================================================
//  scripts/validate-compose.js
//  Runs `docker compose config` across all 4 compose files to
//  validate the merged YAML resolves without errors.
// ================================================================
'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');

const FILES = [
  'compose.core.yml',
  'compose.ops.yml',
  'compose.access.yml',
  'compose.apps.yml',
];

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

// Load .env to get STACK_NAME for project name
let stackName = 'mystack';
if (fs.existsSync('.env')) {
  const raw = fs.readFileSync('.env', 'utf-8');
  const m = raw.match(/^STACK_NAME\s*=\s*(.+)$/m);
  if (m) stackName = m[1].trim().replace(/^["']|["']$/g, '');
}

const fileArgs = FILES.map(f => `-f ${f}`).join(' ');
const cmd = `bash dc.sh config --quiet 2>&1`;

console.log(`\n    Running: docker compose ${fileArgs} config ...\n`);

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('\n✅  Compose configuration is valid!\n');
} catch {
  console.log('\n❌  Compose validation failed — fix YAML errors above.\n');
  process.exit(1);
}
