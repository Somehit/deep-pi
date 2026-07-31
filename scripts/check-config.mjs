#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "config/harness.json");
const contextConfigPath = resolve(root, "config/context.json");
const packagePath = resolve(root, "package.json");
const allowedThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function fail(message) {
  console.error(`Configuration error: ${message}`);
  process.exitCode = 1;
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${configPath}: ${error.message}`);
  process.exit(1);
}

if (!config.modes || typeof config.modes !== "object") {
  fail("modes must be an object");
} else {
  for (const [name, mode] of Object.entries(config.modes)) {
    if (!mode.provider || !mode.model) fail(`${name}: provider and model are required`);
    if (!allowedThinkingLevels.has(mode.thinkingLevel)) fail(`${name}: invalid thinkingLevel`);
    if (!Array.isArray(mode.tools) || mode.tools.length === 0) fail(`${name}: tools must be a non-empty array`);
    if (!mode.instructionsFile) {
      fail(`${name}: instructionsFile is required`);
    } else {
      const instructionsPath = resolve(dirname(configPath), mode.instructionsFile);
      if (!existsSync(instructionsPath)) fail(`${name}: missing ${instructionsPath}`);
    }
  }
}

if (!config.modes?.[config.defaultMode]) fail(`defaultMode '${config.defaultMode}' does not exist`);
const interviewModes = Object.entries(config.modes ?? {})
  .filter(([, mode]) => Array.isArray(mode.tools) && mode.tools.includes("plan_interview"))
  .map(([name]) => name);
if (Object.keys(config.modes ?? {}).sort().join(",") !== "instant,think") {
  fail("the harness must define exactly instant and think modes");
}
if (config.defaultMode !== "instant") fail("defaultMode must be instant");
if (interviewModes.length !== 1 || interviewModes[0] !== "think") {
  fail("plan_interview must be enabled only in think mode");
}
if (!config.modes?.think?.tools?.includes("publish_plan")) fail("publish_plan must be enabled in think");
if (!config.modes?.instant?.tools?.includes("bash")) fail("instant must enable mutation tools");
if (!Array.isArray(config.cycle) || config.cycle.length === 0) {
  fail("cycle must be a non-empty array");
} else {
  for (const name of config.cycle) {
    if (!config.modes?.[name]) fail(`cycle references unknown mode '${name}'`);
  }
}

try {
  const context = JSON.parse(readFileSync(contextConfigPath, "utf8"));
  const thresholds = [context.snipThresholdPercent, context.pruneThresholdPercent, context.compactThresholdPercent];
  if (!thresholds.every((value) => Number.isFinite(value) && value > 0 && value < 100)) {
    fail("context thresholds must be numbers between 0 and 100");
  }
  if (!(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])) {
    fail("context thresholds must satisfy snip < prune < compact");
  }
  if (!allowedThinkingLevels.has(context.compactionThinkingLevel)) {
    fail("invalid compactionThinkingLevel");
  }
  if (!context.maxCompactionProvider || !context.maxCompactionModel) fail("max compaction provider/model are required");
  if (context.maxCompactionThinkingLevel !== "max") fail("maxCompactionThinkingLevel must be max");
  if (!Number.isFinite(context.maxCompactionMaxTokens) || context.maxCompactionMaxTokens < context.compactionMaxTokens) {
    fail("maxCompactionMaxTokens must be at least compactionMaxTokens");
  }
} catch (error) {
  fail(`cannot parse context config: ${error.message}`);
}

for (const relativePath of [
  "instructions/agents/scout.md",
  "instructions/agents/reviewer.md",
  "skills/ocr/SKILL.md",
  "extensions/sensitive-paths.ts",
  "extensions/plan-interview.ts",
  "extensions/deepseek-checkpoints.ts",
  "extensions/checkpoint-store.ts",
  "extensions/deepseek-ocr.ts",
  "extensions/max-workflow.ts",
  "extensions/plan-workflow.ts",
  "instructions/think.md",
  "instructions/instant.md",
  "instructions/max.md",
  "instructions/agents/max-worker.md",
]) {
  if (!existsSync(resolve(root, relativePath))) fail(`missing ${relativePath}`);
}

try {
  const packageConfig = JSON.parse(readFileSync(packagePath, "utf8"));
  for (const extension of [
    "./extensions/deepseek-checkpoints.ts",
    "./extensions/deepseek-ocr.ts",
    "./extensions/deepseek-subagents.ts",
    "./extensions/deepseek-modes.ts",
    "./extensions/plan-interview.ts",
  ]) {
    if (!packageConfig.pi?.extensions?.includes(extension)) fail(`package.json must register ${extension}`);
  }
  if (!packageConfig.peerDependencies?.["@earendil-works/pi-tui"]) {
    fail("package.json must declare @earendil-works/pi-tui as a peer dependency");
  }
} catch (error) {
  fail(`cannot parse package config: ${error.message}`);
}

if (!process.exitCode) console.log("DeepSeek harness configuration: OK");
