import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_STATE_ENTRY, type MaxState, isMaxActive } from "./max-workflow.ts";
import { redactSensitiveLines } from "./sensitive-paths.ts";
import {
  collectPlans,
  formatPlan,
  nextPlanId,
  planEntryTypes,
  selectPlan,
  type PlanStatus,
  type PublishedPlan,
} from "./plan-workflow.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ModeDefinition {
  label?: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  instructionsFile: string;
}
interface HarnessConfig {
  defaultMode: string;
  cycle: string[];
  cycleShortcuts?: string[];
  modes: Record<string, ModeDefinition>;
}
interface LoadedMode extends ModeDefinition { instructions: string }
interface LoadedConfig extends Omit<HarnessConfig, "modes"> { modes: Record<string, LoadedMode> }

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = resolve(packageRoot, "config/harness.json");
const configPath = process.env.PI_DEEPSEEK_HARNESS_CONFIG ? resolve(process.env.PI_DEEPSEEK_HARNESS_CONFIG) : defaultConfigPath;
const maxInstructions = readFileSync(resolve(packageRoot, "instructions/max.md"), "utf8").trim();
const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);

function loadConfig(): LoadedConfig {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as HarnessConfig;
  const configDir = dirname(configPath);
  const modes: Record<string, LoadedMode> = {};
  for (const [name, mode] of Object.entries(raw.modes ?? {})) {
    if (!mode.provider || !mode.model || !Array.isArray(mode.tools) || mode.tools.length === 0) {
      throw new Error(`${configPath}: invalid mode ${name}`);
    }
    modes[name] = { ...mode, instructions: readFileSync(resolve(configDir, mode.instructionsFile), "utf8").trim() };
  }
  if (!modes[raw.defaultMode]) throw new Error(`${configPath}: unknown default mode ${raw.defaultMode}`);
  for (const name of raw.cycle ?? []) if (!modes[name]) throw new Error(`${configPath}: cycle references ${name}`);
  return { ...raw, modes };
}

export default function deepseekModes(pi: ExtensionAPI): void {
  const config = loadConfig();
  const configuredToolSurface = [...new Set(Object.values(config.modes).flatMap((mode) => mode.tools))];
  let activeModeName = config.defaultMode;
  let modeNeedsAnnouncement = true;
  let executionPlan: PublishedPlan | undefined;
  let executionNeedsContext = false;
  let executionInterrupted = false;
  let maxActive = false;
  let maxNeedsContext = false;
  let maxRunId: string | undefined;
  let maxReason: MaxState["reason"] = "command";

  function activeMode(): LoadedMode {
    return config.modes[activeModeName] ?? config.modes[config.defaultMode];
  }

  function branchPlans(ctx: ExtensionContext): PublishedPlan[] {
    return collectPlans(ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>);
  }

  function latestPersistedMode(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: { name?: string } }>;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type === "custom" && entry.customType === "deepseek-harness-mode") return entry.data?.name;
    }
    return undefined;
  }

  function updateStatus(ctx: ExtensionContext): void {
    const suffix = maxActive ? " · MAX" : executionPlan ? ` · execute:${executionPlan.id}` : "";
    ctx.ui.setStatus("deepseek-harness-mode", ctx.ui.theme.fg(maxActive ? "warning" : "accent", `mode:${activeModeName}${suffix}`));
  }

  async function setConfiguredModel(mode: LoadedMode, ctx: ExtensionContext): Promise<boolean> {
    const model = ctx.modelRegistry.find(mode.provider, mode.model);
    if (!model) {
      ctx.ui.notify(`Model not found: ${mode.provider}/${mode.model}`, "error");
      return false;
    }
    const ready = await pi.setModel(model);
    if (!ready) ctx.ui.notify(`Authentication unavailable for ${mode.provider}/${mode.model}. Run /login deepseek.`, "error");
    return ready;
  }

  async function activateMode(
    name: string,
    ctx: ExtensionContext,
    options: { persist?: boolean; notify?: boolean } = {},
  ): Promise<boolean> {
    const mode = config.modes[name];
    if (!mode) {
      ctx.ui.notify(`Unknown mode ${name}. Available: ${Object.keys(config.modes).join(", ")}`, "error");
      return false;
    }
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const stable = configuredToolSurface.filter((tool) => available.has(tool));
    if (stable.length === 0) {
      ctx.ui.notify("No configured harness tools are available", "error");
      return false;
    }
    const ready = await setConfiguredModel(mode, ctx);
    activeModeName = name;
    modeNeedsAnnouncement = true;
    pi.setThinkingLevel(mode.thinkingLevel);
    pi.setActiveTools(stable);
    if (options.persist !== false) pi.appendEntry("deepseek-harness-mode", { name });
    updateStatus(ctx);
    if (options.notify !== false) ctx.ui.notify(`Mode ${name}: ${mode.model}, thinking ${mode.thinkingLevel}`, ready ? "info" : "warning");
    return ready;
  }

  async function activateMaxModel(ctx: ExtensionContext): Promise<boolean> {
    const model = ctx.modelRegistry.find("deepseek", "deepseek-v4-pro");
    if (!model || !(await pi.setModel(model))) {
      ctx.ui.notify("DeepSeek V4 Pro authentication is required for /max", "error");
      return false;
    }
    pi.setThinkingLevel("max");
    return true;
  }

  function persistMax(active: boolean, reason: MaxState["reason"]): void {
    pi.appendEntry(MAX_STATE_ENTRY, {
      active,
      runId: maxRunId ?? "unknown",
      originMode: activeModeName,
      reason,
      timestamp: Date.now(),
    } satisfies MaxState);
  }

  async function beginMax(ctx: ExtensionContext, reason: MaxState["reason"]): Promise<boolean> {
    if (!(await activateMaxModel(ctx))) return false;
    maxActive = true;
    maxNeedsContext = true;
    maxReason = reason;
    maxRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    persistMax(true, reason);
    updateStatus(ctx);
    return true;
  }

  async function endTransientRun(ctx: ExtensionContext): Promise<void> {
    if (executionPlan) {
      const status: PlanStatus = executionInterrupted ? "interrupted" : "attempted";
      pi.appendEntry(planEntryTypes.state, { id: executionPlan.id, status, timestamp: Date.now() });
      executionPlan = undefined;
      executionNeedsContext = false;
      executionInterrupted = false;
    }
    if (maxActive) {
      persistMax(false, maxReason);
      maxActive = false;
      maxNeedsContext = false;
      maxRunId = undefined;
      maxReason = "command";
    }
    const mode = activeMode();
    await setConfiguredModel(mode, ctx);
    pi.setThinkingLevel(mode.thinkingLevel);
    updateStatus(ctx);
  }

  pi.registerTool({
    name: "publish_plan",
    label: "Publish Plan",
    description: "Publish the final implementation-ready plan in Think mode. Call this tool alone as the final action of the turn.",
    promptSnippet: "Publish a final structured implementation plan in Think mode",
    promptGuidelines: ["Call publish_plan alone, never alongside another tool in the same batch.", "Use it only when an implementation plan is ready for /execute."],
    parameters: Type.Object({
      objective: Type.String({ minLength: 1 }),
      steps: Type.Array(Type.Object({
        description: Type.String({ minLength: 1 }),
        files: Type.Array(Type.String()),
        verification: Type.String({ minLength: 1 }),
      }), { minItems: 1 }),
      risks: Type.Array(Type.String()),
      finalVerification: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (activeModeName !== "think" || executionPlan) throw new Error("publish_plan is available only in read-only Think mode");
      const plans = branchPlans(ctx);
      const plan: PublishedPlan = {
        id: nextPlanId(plans),
        objective: params.objective,
        steps: params.steps,
        risks: params.risks,
        finalVerification: params.finalVerification,
        effort: maxActive ? "max" : "normal",
        status: "ready",
        createdAt: Date.now(),
      };
      pi.appendEntry(planEntryTypes.plan, plan);
      return { content: [{ type: "text", text: formatPlan(plan) }], details: plan, terminate: true };
    },
  });

  function statusText(ctx: ExtensionContext): string {
    const plans = branchPlans(ctx);
    const latest = plans.at(-1);
    return `Mode ${activeModeName}: ${activeMode().model}/${activeMode().thinkingLevel}${maxActive ? " · MAX" : ""}${latest ? ` · latest plan ${latest.id}:${latest.status}` : ""}`;
  }

  pi.registerCommand("status", {
    description: "Show harness mode, model, Max state, and latest plan",
    handler: async (_args, ctx) => { ctx.ui.notify(statusText(ctx), "info"); },
  });

  pi.registerCommand("diff", {
    description: "Show the current redacted Git status and diff",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd, timeout: 5000 });
      if (probe.code !== 0) { ctx.ui.notify("Current directory is not a Git worktree", "warning"); return; }
      const status = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd, timeout: 30_000 });
      const diff = await pi.exec("git", ["diff", "--no-ext-diff", "HEAD"], { cwd: ctx.cwd, timeout: 30_000 });
      const body = redactSensitiveLines(`## Status\n${status.stdout || "(clean)"}\n\n## Diff\n${diff.stdout || "(empty)"}`);
      pi.sendMessage({ customType: "deepseek-harness-diff", content: body.slice(0, 100_000), display: true });
    },
  });

  pi.registerCommand("mode", {
    description: "Select or inspect Think/Instant mode",
    getArgumentCompletions: (prefix) => {
      const matches = [...Object.keys(config.modes), "status"].filter((value) => value.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish", "warning"); return; }
      const requested = args.trim();
      if (requested === "status") {
        ctx.ui.notify(statusText(ctx), "info");
        return;
      }
      let selected = requested;
      if (!selected) {
        selected = (await ctx.ui.select("DeepSeek mode", Object.keys(config.modes).map((name) => `${name}${name === activeModeName ? " (active)" : ""}`)))?.split(/\s/)[0] ?? "";
      }
      if (selected) await activateMode(selected, ctx);
    },
  });

  for (const name of ["think", "instant"] as const) {
    pi.registerCommand(name, {
      description: `Switch to ${name} mode; optional trailing text is submitted as the task`,
      handler: async (args, ctx) => {
        if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish", "warning"); return; }
        const task = args.trim();
        if (!(await activateMode(name, ctx))) {
          if (task) ctx.ui.setEditorText(task);
          return;
        }
        if (task) pi.sendUserMessage(task);
      },
    });
  }

  pi.registerCommand("execute", {
    description: "Execute a published plan inside Think, then relock mutations",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish", "warning"); return; }
      if (activeModeName !== "think") { ctx.ui.notify("/execute is available only in Think mode", "warning"); return; }
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const skipConfirmation = tokens.some((token) => /^(?:--yes|-y|yes)$/i.test(token));
      const requestedId = tokens.find((token) => !/^(?:--yes|-y|yes)$/i.test(token));
      const plan = selectPlan(branchPlans(ctx), requestedId);
      if (!plan) { ctx.ui.notify(requestedId ? `Plan ${requestedId} not found` : "No ready published plan. Ask Think to produce one first.", "warning"); return; }
      if (!skipConfirmation) {
        if (!ctx.hasUI) { ctx.ui.notify("Use /execute --yes in non-interactive mode", "warning"); return; }
        if (!(await ctx.ui.confirm(`Execute plan ${plan.id}?`, formatPlan(plan).slice(0, 4000)))) return;
      }
      if (plan.effort === "max" && !(await beginMax(ctx, "plan-execution"))) return;
      executionPlan = plan;
      executionNeedsContext = true;
      executionInterrupted = false;
      pi.appendEntry(planEntryTypes.state, { id: plan.id, status: "executing", timestamp: Date.now() });
      updateStatus(ctx);
      pi.sendUserMessage(`Execute approved plan ${plan.id}.`);
    },
  });

  pi.registerCommand("max", {
    description: "Run a one-shot Pro/max multi-agent council above the current mode",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current run to finish", "warning"); return; }
      let task = args.trim();
      if (!task && ctx.hasUI) task = (await ctx.ui.input("Max task:", "What requires maximal scrutiny?"))?.trim() ?? "";
      if (!task) { ctx.ui.notify("Usage: /max <task>", "warning"); return; }
      if (!(await beginMax(ctx, "command"))) { ctx.ui.setEditorText(task); return; }
      pi.sendUserMessage(task);
    },
  });

  async function cycleMode(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle() || maxActive || executionPlan) { ctx.ui.notify("Wait for the current run to finish", "warning"); return; }
    const index = config.cycle.indexOf(activeModeName);
    await activateMode(config.cycle[index < 0 ? 0 : (index + 1) % config.cycle.length], ctx);
  }
  for (const shortcut of config.cycleShortcuts ?? []) pi.registerShortcut(shortcut, { description: "Cycle Think/Instant mode", handler: cycleMode });

  pi.on("tool_call", (event) => {
    if (event.toolName === "deepseek_max_round" && !maxActive) return { block: true, reason: "deepseek_max_round is available only during /max" };
    if (activeModeName === "think" && MUTATION_TOOLS.has(event.toolName)) {
      if (executionPlan) return;
      return { block: true, reason: "Think is read-only. Publish a plan and use /execute to approve mutations." };
    }
    if (executionPlan && MUTATION_TOOLS.has(event.toolName)) return;
    if (activeMode().tools.includes(event.toolName)) return;
    return { block: true, reason: `Tool ${event.toolName} is disabled in ${activeModeName}` };
  });

  pi.on("before_agent_start", () => {
    const sections: string[] = [];
    if (modeNeedsAnnouncement) {
      modeNeedsAnnouncement = false;
      sections.push(`[DEEPSEEK HARNESS MODE: ${activeModeName.toUpperCase()}]\nThese instructions supersede earlier harness-mode instructions.\n\n${activeMode().instructions}`);
    }
    if (maxActive && maxNeedsContext) {
      maxNeedsContext = false;
      sections.push(`[MAX WORKFLOW ACTIVE — ${activeModeName.toUpperCase()} PERMISSIONS APPLY]\n\n${maxInstructions}`);
    }
    if (executionPlan && executionNeedsContext) {
      executionNeedsContext = false;
      sections.push(`[USER-APPROVED EXECUTION — PLAN ${executionPlan.id}]\nMutation tools are temporarily approved for this run only. Execute, verify, and report.\n\n${formatPlan(executionPlan)}`);
    }
    if (sections.length === 0) return;
    return { message: { customType: "deepseek-harness-context", content: sections.join("\n\n"), display: false } };
  });

  pi.on("turn_end", (event) => {
    if (!executionPlan || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") executionInterrupted = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (executionPlan || maxActive) await endTransientRun(ctx);
  });

  pi.on("session_compact", () => { modeNeedsAnnouncement = true; });
  pi.on("session_tree", async (_event, ctx) => {
    executionPlan = undefined;
    executionNeedsContext = false;
    maxActive = false;
    maxNeedsContext = false;
    const restored = latestPersistedMode(ctx);
    const target = restored && config.modes[restored] ? restored : config.defaultMode;
    if (target !== activeModeName) await activateMode(target, ctx, { persist: false, notify: false });
    else { modeNeedsAnnouncement = true; updateStatus(ctx); }
  });
  pi.on("session_start", async (_event, ctx) => {
    executionPlan = undefined;
    maxActive = false;
    maxNeedsContext = false;
    if (isMaxActive(ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>)) {
      maxRunId = "interrupted";
      persistMax(false, "command");
    }
    const restored = latestPersistedMode(ctx);
    await activateMode(restored && config.modes[restored] ? restored : config.defaultMode, ctx, { persist: false, notify: false });
  });
}
