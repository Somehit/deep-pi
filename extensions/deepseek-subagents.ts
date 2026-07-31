import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_ROLES,
  addUsage,
  emptyUsage,
  maxWorkerInstructions,
  validateAssignments,
  type MaxAssignment,
  type MaxRole,
} from "./max-workflow.ts";
import { redactSensitiveLines } from "./sensitive-paths.ts";

type AgentRole = "scout" | "reviewer" | "adversarial" | "reviewer-flash" | "adversarial-flash";
interface AgentDefinition { model: string; thinking: "high" | "max"; tools: string[]; instructions: string; extensions?: string[] }
interface AgentRunResult {
  role: string;
  model: string;
  output: string;
  exitCode: number;
  stderr: string;
  usage: Usage;
  stopReason?: string;
  errorMessage?: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sensitivePathsExtension = resolve(packageRoot, "extensions/sensitive-paths.ts");
const searchExtension = resolve(packageRoot, "extensions/deepseek-search.ts");
const maxWorkerBase = readFileSync(resolve(packageRoot, "instructions/agents/max-worker.md"), "utf8").trim();

function loadAgent(role: AgentRole): AgentDefinition {
  const flash = role === "scout" || role.endsWith("-flash");
  return {
    model: flash ? "deepseek-v4-flash" : "deepseek-v4-pro",
    thinking: flash ? "high" : "max",
    tools: ["read", "grep", "find", "ls"],
    instructions: readFileSync(resolve(packageRoot, `instructions/agents/${role}.md`), "utf8").trim(),
    extensions: [sensitivePathsExtension],
  };
}

function loadMaxAgent(role: MaxRole): AgentDefinition {
  return {
    model: "deepseek-v4-pro",
    thinking: "max",
    tools: ["read", "grep", "find", "ls", "web_search"],
    instructions: maxWorkerInstructions(role, maxWorkerBase),
    extensions: [sensitivePathsExtension, searchExtension],
  };
}

function finalAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

async function gitReviewContext(pi: ExtensionAPI, cwd: string): Promise<string> {
  const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
  if (probe.code !== 0 || probe.stdout.trim() !== "true") return "(not a Git worktree)";
  const sections: string[] = [];
  for (const [label, args] of [
    ["status", ["status", "--short"]],
    ["unstaged diff", ["diff", "--no-ext-diff"]],
    ["staged diff", ["diff", "--cached", "--no-ext-diff"]],
  ] as Array<[string, string[]]>) {
    const result = await pi.exec("git", args, { cwd, timeout: 30_000 });
    sections.push(`## ${label}\n${result.stdout || result.stderr || "(empty)"}`);
  }
  const truncated = truncateHead(redactSensitiveLines(sections.join("\n\n")), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return `${truncated.content}${truncated.truncated ? "\n\n[Git context truncated; inspect files directly.]" : ""}`;
}

async function runAgent(
  pi: ExtensionAPI,
  role: string,
  definition: AgentDefinition,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<AgentRunResult> {
  const temporaryDir = await mkdtemp(join(tmpdir(), `pi-deepseek-${role.replace(/[^a-z0-9_-]/gi, "-")}-`));
  const promptPath = join(temporaryDir, "SYSTEM.md");
  await writeFile(promptPath, definition.instructions, { encoding: "utf8", mode: 0o600 });
  const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  for (const extension of definition.extensions ?? []) args.push("-e", extension);
  args.push(
    "--no-skills", "--no-prompt-templates", "--provider", "deepseek", "--model", definition.model,
    "--thinking", definition.thinking, "--tools", definition.tools.join(","), "--append-system-prompt", promptPath,
    `Task: ${task}`,
  );

  const messages: Message[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  try {
    onProgress?.(`Starting ${role} with ${definition.model}...`);
    const invocation = piInvocation(args);
    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let aborted = false;
      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as { type?: string; message?: Message };
          if (event.type !== "message_end" || !event.message) return;
          const message = event.message;
          messages.push(message);
          addUsage(usage, (message as Message & { usage?: Usage }).usage);
          if (message.role === "assistant") {
            stopReason = message.stopReason;
            errorMessage = message.errorMessage;
            const preview = finalAssistantText([message]);
            if (preview) onProgress?.(`${role}: ${preview.slice(0, 160)}`);
          }
        } catch { /* Ignore non-JSON progress lines. */ }
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-20_000); });
      child.on("error", (error) => { stderr += `\n${error.message}`; resolveExit(1); });
      child.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolveExit(aborted ? 130 : (code ?? 1)); });
      const abort = () => { aborted = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      child.on("close", () => signal?.removeEventListener("abort", abort));
    });
    const raw = finalAssistantText(messages) || errorMessage || stderr.trim() || "(no subagent output)";
    const truncated = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    return {
      role, model: definition.model, output: `${truncated.content}${truncated.truncated ? "\n\n[Subagent output truncated.]" : ""}`,
      exitCode, stderr, usage, stopReason, errorMessage,
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export default function deepseekSubagents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deepseek_delegate",
    label: "DeepSeek Delegate",
    description: "Delegate isolated read-only investigation or review to a DeepSeek subagent.",
    parameters: Type.Object({
      role: StringEnum(["scout", "reviewer", "adversarial", "reviewer-flash", "adversarial-flash"] as const),
      task: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const definition = loadAgent(params.role);
      let task = params.task;
      if (params.role.startsWith("reviewer") || params.role.startsWith("adversarial")) {
        task += `\n\n<current-git-context>\n${await gitReviewContext(pi, ctx.cwd)}\n</current-git-context>`;
      }
      const result = await runAgent(pi, params.role, definition, task, ctx.cwd, signal, (message) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details: { role: params.role } });
      });
      if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(`${params.role} failed: ${result.errorMessage || result.stderr || result.output}`);
      }
      return {
        content: [{ type: "text", text: `[${params.role} via ${result.model}]\n\n${result.output}` }],
        details: { role: result.role, model: result.model, exitCode: result.exitCode, stopReason: result.stopReason },
        usage: result.usage,
      };
    },
  });

  pi.registerTool({
    name: "deepseek_max_round",
    label: "DeepSeek Max Council Round",
    description: "Run one parallel council round of independent V4 Pro/max read-only workers. Available only inside /max.",
    executionMode: "sequential",
    parameters: Type.Object({
      stage: Type.String({ minLength: 1, description: "Purpose of this round" }),
      assignments: Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        role: StringEnum(MAX_ROLES),
        task: Type.String({ minLength: 1 }),
      }), { minItems: 1, maxItems: 12 }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const assignments = params.assignments as MaxAssignment[];
      const invalid = validateAssignments(assignments);
      if (invalid) throw new Error(invalid);
      const results: Array<AgentRunResult | { role: string; error: string }> = [];
      const concurrency = 6;
      for (let index = 0; index < assignments.length; index += concurrency) {
        if (signal?.aborted) throw new Error("Max round aborted");
        const chunk = assignments.slice(index, index + concurrency);
        const settled = await Promise.allSettled(chunk.map((assignment) => runAgent(
          pi,
          `max-${assignment.role}-${assignment.id}`,
          loadMaxAgent(assignment.role),
          `Council stage: ${params.stage}\nAssignment id: ${assignment.id}\n\n${assignment.task}`,
          ctx.cwd,
          signal,
          (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { stage: params.stage, id: assignment.id } }),
        )));
        settled.forEach((outcome, offset) => {
          const assignment = chunk[offset];
          results.push(outcome.status === "fulfilled" ? outcome.value : { role: `${assignment.role}:${assignment.id}`, error: String(outcome.reason) });
        });
      }
      const usage = emptyUsage();
      const reports = results.map((result, index) => {
        const assignment = assignments[index];
        if ("error" in result) return `## ${assignment.id} · ${assignment.role} · FAILED\n${result.error}`;
        addUsage(usage, result.usage);
        const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        return `## ${assignment.id} · ${assignment.role} · ${failed ? "FAILED" : result.model}\n${failed ? result.errorMessage || result.stderr : result.output}`;
      });
      return {
        content: [{ type: "text", text: `# Max round: ${params.stage}\n\n${reports.join("\n\n")}` }],
        details: { stage: params.stage, workers: assignments.length, failures: results.filter((result) => "error" in result || ("exitCode" in result && result.exitCode !== 0)).length },
        usage,
      };
    },
  });

  function commandLabel(role: AgentRole): string {
    return role === "reviewer" ? "review" : role === "reviewer-flash" ? "review-flash" : role;
  }
  async function runFromCommand(role: AgentRole, args: string, ctx: ExtensionContext): Promise<void> {
    let task = args.trim();
    if (!task && ctx.hasUI) task = (await ctx.ui.input(`${role} task:`, "What should the subagent investigate?"))?.trim() ?? "";
    if (!task) { ctx.ui.notify(`Usage: /${commandLabel(role)} <task>`, "warning"); return; }
    ctx.ui.setStatus("deepseek-subagent", `${role}: running`);
    try {
      let effectiveTask = task;
      if (role.startsWith("reviewer") || role.startsWith("adversarial")) effectiveTask += `\n\n<current-git-context>\n${await gitReviewContext(pi, ctx.cwd)}\n</current-git-context>`;
      const result = await runAgent(pi, role, loadAgent(role), effectiveTask, ctx.cwd, undefined, (message) => ctx.ui.setStatus("deepseek-subagent", message.slice(0, 80)));
      if (result.exitCode !== 0 || result.stopReason === "error") { ctx.ui.notify(`${role} failed: ${result.errorMessage || result.stderr}`, "error"); return; }
      pi.sendMessage({ customType: "deepseek-subagent-result", content: `[${role} via ${result.model}]\n\n${result.output}`, display: true, details: { role, model: result.model, usage: result.usage } });
    } finally { ctx.ui.setStatus("deepseek-subagent", undefined); }
  }
  pi.registerCommand("scout", { description: "Run isolated read-only Scout (Flash)", handler: async (args, ctx) => runFromCommand("scout", args, ctx) });
  pi.registerCommand("review", { description: "Review current Git diff (Pro)", handler: async (args, ctx) => runFromCommand("reviewer", args, ctx) });
  pi.registerCommand("review-flash", { description: "Review current Git diff (Flash)", handler: async (args, ctx) => runFromCommand("reviewer-flash", args, ctx) });
  pi.registerCommand("adversarial-flash", { description: "Adversarial review (Flash)", handler: async (args, ctx) => runFromCommand("adversarial-flash", args, ctx) });
}
