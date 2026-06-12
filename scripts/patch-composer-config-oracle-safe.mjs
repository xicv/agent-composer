#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const configPath = process.argv[2] ?? 'composer.config.json';
if (!fs.existsSync(configPath)) {
  console.error(`No ${configPath} found`);
  process.exit(1);
}
const raw = fs.readFileSync(configPath, 'utf8');
let cfg;
try { cfg = JSON.parse(raw); } catch (err) {
  console.error(`Failed to parse ${configPath}: ${err.message}`);
  process.exit(1);
}

const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(configPath, backup);

cfg.roles ??= {};
cfg.roles.researcher = {
  provider: 'cli',
  cli: ['bash', 'scripts/composer-oracle-router-safe.sh'],
  timeoutMs: 1200000,
  retries: 0,
  maxResultChars: 14000,
};

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`Updated ${configPath}`);
console.log(`Backup: ${backup}`);
console.log('Researcher now routes through scripts/composer-oracle-router-safe.sh');
