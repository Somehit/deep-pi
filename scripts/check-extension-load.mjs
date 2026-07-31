#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensions = [
  "sensitive-paths.ts",
  "deepseek-checkpoints.ts",
  "deepseek-ocr.ts",
  "deepseek-subagents.ts",
  "deepseek-modes.ts",
  "plan-interview.ts",
  "deepseek-context.ts",
  "deepseek-efficiency.ts",
  "deepseek-search.ts",
];
const args = ["--mode", "rpc", "--no-session", "--no-extensions"];
for (const extension of extensions) args.push("-e", resolve(root, "extensions", extension));
const result = spawnSync("pi", args, {
  cwd: root,
  input: '{"type":"get_state"}\n{"type":"get_commands"}\n',
  encoding: "utf8",
  timeout: 30_000,
});
if (result.error) throw result.error;
const output = `${result.stderr || ""}\n${result.stdout || ""}`;
if (result.status !== 0 || /Failed to load extension|ParseError/i.test(output)) {
  process.stderr.write(output);
  process.exit(result.status || 1);
}
const responses = (result.stdout || "").split("\n").filter(Boolean).flatMap((line) => {
  try { const value = JSON.parse(line); return value.type === "response" ? [value] : []; } catch { return []; }
});
const state = responses.find((response) => response.command === "get_state")?.data;
if (state?.model?.id !== "deepseek-v4-flash" || state?.thinkingLevel !== "high") {
  throw new Error("Instant did not load as deepseek-v4-flash/high");
}
const names = new Set((responses.find((response) => response.command === "get_commands")?.data?.commands ?? []).map((command) => command.name));
for (const name of ["think", "instant", "execute", "undo", "redo", "max", "status", "diff"]) {
  if (!names.has(name)) throw new Error(`Missing harness command: /${name}`);
}
for (const removed of ["brainstorm", "plan", "build", "ferrari", "execute-ferrari"]) {
  if (names.has(removed)) throw new Error(`Removed command still registered: /${removed}`);
}
console.log("Extension load: OK");
