#!/usr/bin/env node
import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const distEntry = resolve("dist/index.js");
if (!existsSync(distEntry)) {
  console.error(`postbuild: ${distEntry} not found; did tsc emit?`);
  process.exit(1);
}
chmodSync(distEntry, 0o755);
console.log(`postbuild: chmod +x dist/index.js`);
