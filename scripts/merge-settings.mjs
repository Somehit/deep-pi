#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [targetPath, defaultsPath] = process.argv.slice(2);
if (!targetPath || !defaultsPath) {
  console.error("Usage: merge-settings.mjs <target-settings.json> <defaults.json>");
  process.exit(2);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot parse ${path}: ${error.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(target, source) {
  const result = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = isPlainObject(value) ? merge(result[key], value) : value;
  }
  return result;
}

const current = readJson(targetPath, {});
const defaults = readJson(defaultsPath, {});
const merged = merge(current, defaults);
const temporaryPath = `${targetPath}.tmp-${process.pid}`;

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, targetPath);
console.log(`Merged DeepSeek defaults into ${targetPath}`);
