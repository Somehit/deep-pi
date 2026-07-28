#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import {
  commandTouchesSensitivePath,
  normalizeInputPath,
  protectedReason,
  redactSensitiveLines,
} from "../extensions/sensitive-paths.ts";

const cases = [
  [commandTouchesSensitivePath("cat .env"), true],
  [commandTouchesSensitivePath("cat .env.local"), true],
  [commandTouchesSensitivePath("cat ~/.ssh/id_ed25519"), true],
  [commandTouchesSensitivePath("ssh example.com"), false],
  [commandTouchesSensitivePath("npm test"), false],
  [protectedReason(normalizeInputPath(".env", process.cwd())), true],
  [protectedReason(join(homedir(), ".ssh", "config")), true],
];

for (const [value, expected] of cases) {
  if (Boolean(value) !== expected) throw new Error(`Sensitive-path check failed: ${value} (expected ${expected})`);
}

const diff = [
  "diff --git a/.env b/.env",
  "--- a/.env",
  "+++ b/.env",
  "-SECRET=old",
  "+SECRET=new",
  "diff --git a/src/app.ts b/src/app.ts",
  "+safe change",
].join("\n");
const redacted = redactSensitiveLines(diff);
if (redacted.includes("SECRET") || !redacted.includes("src/app.ts") || !redacted.includes("safe change")) {
  throw new Error("Sensitive Git diff redaction failed");
}

console.log("Sensitive path guard: OK");
