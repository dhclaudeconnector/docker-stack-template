#!/usr/bin/env node
// ================================================================
//  docker-compose/scripts/validate-compose.js
//  Runs `docker compose config` across all 4 compose files to
//  validate the merged YAML resolves without errors.
// ================================================================
'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');

const FILES = [
  'docker-compose/compose.core.yml',
  'docker-compose/compose.ops.yml',
  'docker-compose/compose.access.yml',
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

const fileArgs = FILES.map(f => `-f ${f}`).join(' ');
const cmd = `bash docker-compose/scripts/dc.sh config --quiet 2>&1`;

console.log(`\n    Running: docker compose ${fileArgs} config ...\n`);

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('\n✅  Compose configuration is valid!\n');
} catch {
  console.log('\n❌  Compose validation failed — fix YAML errors above.\n');
  process.exit(1);
}
