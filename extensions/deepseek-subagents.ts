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
import { redactSensitiveLines } from "./sensitive-paths.ts";

type AgentRole = "scout" | "reviewer";

interface AgentDefinition {
  model: string;
  thinking: "high" | "max";
  tools: string[];
  instructions: string;
}

interface AgentRunResult {
  role: AgentRole;
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

function loadAgent(role: AgentRole): AgentDefinition {
  const instructions = readFileSync(resolve(packageRoot, `instructions/agents/${role}.md`), "utf8").trim();
  return role === "scout"
    ? {
        model: "deepseek-v4-flash",
        thinking: "high",
        tools: ["read", "grep", "find", "ls"],
        instructions,
      }
    : {
        model: "deepseek-v4-pro",
        thinking: "max",
        tools: ["read", "grep", "find", "ls"],
        instructions,
      };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  total.input += usage.input || 0;
  total.output += usage.output || 0;
  total.cacheRead += usage.cacheRead || 0;
  total.cacheWrite += usage.cacheWrite || 0;
  total.totalTokens += usage.totalTokens || 0;
  total.cost.input += usage.cost?.input || 0;
  total.cost.output += usage.cost?.output || 0;
  total.cost.cacheRead += usage.cost?.cacheRead || 0;
  total.cost.cacheWrite += usage.cost?.cacheWrite || 0;
  total.cost.total += usage.cost?.total || 0;
}

function finalAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

async function gitReviewContext(pi: ExtensionAPI, cwd: string): Promise<string> {
  const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
  if (probe.code !== 0 || probe.stdout.trim() !== "true") return "(not a Git worktree)";

  const commands: Array<[string, string[]]> = [
    ["status", ["status", "--short"]],
    ["unstaged diff", ["diff", "--no-ext-diff"]],
    ["staged diff", ["diff", "--cached", "--no-ext-diff"]],
  ];
  const sections: string[] = [];
  for (const [label, args] of commands) {
    const result = await pi.exec("git", args, { timeout: 30_000 });
    sections.push(`## ${label}\n${result.stdout || result.stderr || "(empty)"}`);
  }

  const combined = redactSensitiveLines(sections.join("\n\n"));
  const truncated = truncateHead(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return `${truncated.content}${truncated.truncated ? "\n\n[Git context truncated; inspect relevant files directly.]" : ""}`;
}

async function runAgent(
  pi: ExtensionAPI,
  role: AgentRole,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<AgentRunResult> {
  const agent = loadAgent(role);
  const temporaryDir = await mkdtemp(join(tmpdir(), `pi-deepseek-${role}-`));
  const promptPath = join(temporaryDir, "SYSTEM.md");
  await writeFile(promptPath, agent.instructions, { encoding: "utf8", mode: 0o600 });

  let effectiveTask = task;
  if (role === "reviewer") {
    onProgress?.("Collecting Git diff for reviewer...");
    effectiveTask += `\n\n<current-git-context>\n${await gitReviewContext(pi, cwd)}\n</current-git-context>`;
  }

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "-e",
    sensitivePathsExtension,
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    "deepseek",
    "--model",
    agent.model,
    "--thinking",
    agent.thinking,
    "--tools",
    agent.tools.join(","),
    "--append-system-prompt",
    promptPath,
    `Task: ${effectiveTask}`,
  ];

  const messages: Message[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  try {
    onProgress?.(`Starting ${role} with ${agent.model}...`);
    const invocation = piInvocation(args);
    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let aborted = false;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, any>;
        try {
          event = JSON.parse(line) as Record<string, any>;
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          messages.push(message);
          if (message.role === "assistant") {
            addUsage(usage, message.usage);
            stopReason = message.stopReason;
            errorMessage = message.errorMessage;
            const preview = finalAssistantText([message]);
            if (preview) onProgress?.(`${role}: ${preview.slice(0, 160)}`);
          }
        }
      };

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        resolveExit(1);
      });
      child.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolveExit(aborted ? 130 : (code ?? 1));
      });

      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.on("close", () => signal?.removeEventListener("abort", abort));
    });

    const rawOutput = finalAssistantText(messages) || errorMessage || stderr.trim() || "(no subagent output)";
    const truncated = truncateHead(rawOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    const output = `${truncated.content}${truncated.truncated ? "\n\n[Subagent output truncated.]" : ""}`;
    return { role, model: agent.model, output, exitCode, stderr, usage, stopReason, errorMessage };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export default function deepseekSubagentsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deepseek_delegate",
    label: "DeepSeek Delegate",
    description: "Delegate isolated read-only investigation to Scout (Flash/max) or code review to Reviewer (Pro/max).",
    parameters: Type.Object({
      role: StringEnum(["scout", "reviewer"] as const),
      task: Type.String({ description: "Specific, bounded task for the subagent" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runAgent(pi, params.role, params.task, ctx.cwd, signal, (message) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details: { role: params.role } });
      });
      if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(`${params.role} failed: ${result.errorMessage || result.stderr || result.output}`);
      }
      return {
        content: [{ type: "text", text: `[${params.role} via ${result.model}]\n\n${result.output}` }],
        details: {
          role: result.role,
          model: result.model,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
        },
        usage: result.usage,
      };
    },
  });

  async function runFromCommand(role: AgentRole, args: string, ctx: ExtensionContext): Promise<void> {
    let task = args.trim();
    if (!task && ctx.hasUI) task = (await ctx.ui.input(`${role} task:`, "What should the subagent investigate?"))?.trim() ?? "";
    if (!task) {
      ctx.ui.notify(`Usage: /${role === "reviewer" ? "review" : "scout"} <task>`, "warning");
      return;
    }

    ctx.ui.setStatus("deepseek-subagent", `${role}: running`);
    try {
      const result = await runAgent(pi, role, task, ctx.cwd, undefined, (message) => {
        ctx.ui.setStatus("deepseek-subagent", message.slice(0, 80));
      });
      if (result.exitCode !== 0 || result.stopReason === "error") {
        ctx.ui.notify(`${role} failed: ${result.errorMessage || result.stderr}`, "error");
        return;
      }
      pi.sendMessage({
        customType: "deepseek-subagent-result",
        content: `[${role} via ${result.model}]\n\n${result.output}`,
        display: true,
        details: { role, model: result.model, usage: result.usage },
      });
    } finally {
      ctx.ui.setStatus("deepseek-subagent", undefined);
    }
  }

  pi.registerCommand("scout", {
    description: "Run an isolated read-only Scout with DeepSeek Flash/max",
    handler: async (args, ctx) => runFromCommand("scout", args, ctx),
  });

  pi.registerCommand("review", {
    description: "Review the current Git diff with an isolated DeepSeek Pro/max agent",
    handler: async (args, ctx) => runFromCommand("reviewer", args, ctx),
  });
}
