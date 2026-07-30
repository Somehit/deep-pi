import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createWorker, OEM } from "tesseract.js";
import { Type } from "typebox";
import { detectFerrariPlan, ferrariBuildInstructions, isMutationTool } from "./ferrari-workflow.ts";

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

interface LoadedMode extends ModeDefinition {
  instructions: string;
}

interface LoadedConfig extends Omit<HarnessConfig, "modes"> {
  modes: Record<string, LoadedMode>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = resolve(packageRoot, "config/harness.json");
const configPath = process.env.PI_DEEPSEEK_HARNESS_CONFIG
  ? resolve(process.env.PI_DEEPSEEK_HARNESS_CONFIG)
  : defaultConfigPath;

function loadConfig(): LoadedConfig {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as HarnessConfig;
  const configDir = dirname(configPath);
  const modes: Record<string, LoadedMode> = {};

  if (!raw.modes || typeof raw.modes !== "object") {
    throw new Error(`${configPath}: "modes" must be an object`);
  }

  for (const [name, mode] of Object.entries(raw.modes)) {
    if (!mode.provider || !mode.model) {
      throw new Error(`${configPath}: mode "${name}" needs provider and model`);
    }
    if (!Array.isArray(mode.tools) || mode.tools.length === 0) {
      throw new Error(`${configPath}: mode "${name}" needs at least one tool`);
    }

    const instructionsPath = resolve(configDir, mode.instructionsFile);
    modes[name] = {
      ...mode,
      instructions: readFileSync(instructionsPath, "utf8").trim(),
    };
  }

  if (!modes[raw.defaultMode]) {
    throw new Error(`${configPath}: unknown default mode "${raw.defaultMode}"`);
  }
  if (!Array.isArray(raw.cycle) || raw.cycle.length === 0) {
    throw new Error(`${configPath}: "cycle" must contain at least one mode`);
  }
  for (const name of raw.cycle) {
    if (!modes[name]) throw new Error(`${configPath}: cycle references unknown mode "${name}"`);
  }

  return { ...raw, modes };
}

export default function deepseekModesExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const configuredToolSurface = [...new Set(Object.values(config.modes).flatMap((mode) => mode.tools))];
  let activeModeName = config.defaultMode;
  let modeNeedsAnnouncement = true;
  let latestPlanText: string | undefined;
  // Ferrari workflow
  let ferrariPhase: "planning" | "executing" = "planning";
  let ferrariPlanText: string | undefined;
  let ferrariPlanPending = false;
  let ferrariBuildPending = false;
  let ferrariComplete = false;

  function activeMode(): LoadedMode {
    return config.modes[activeModeName] ?? config.modes[config.defaultMode];
  }

  pi.registerTool({
    name: "ocr_image",
    label: "OCR Image",
    description: "Extract text from a local image with Tesseract OCR. Read-only for the project; defaults to French and English.",
    parameters: Type.Object({
      path: Type.String({ description: "Image path, absolute or relative to the current working directory" }),
      languages: Type.Optional(
        Type.String({ description: "Tesseract language codes joined with + (default: fra+eng)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const imagePath = resolve(ctx.cwd, rawPath);
      const imageStat = await stat(imagePath).catch(() => undefined);
      if (!imageStat?.isFile()) throw new Error(`OCR image not found or not a file: ${imagePath}`);

      const languages = params.languages?.trim() || "fra+eng";
      if (!/^[a-z0-9_+-]+$/i.test(languages)) {
        throw new Error(`Invalid Tesseract language expression: ${languages}`);
      }

      const cachePath = join(homedir(), ".cache", "pi-deepseek-harness", "tesseract");
      await mkdir(cachePath, { recursive: true });
      onUpdate?.({
        content: [{ type: "text", text: `Loading OCR languages ${languages}...` }],
        details: { imagePath, languages },
      });

      let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
      const abortWorker = () => {
        if (worker) void worker.terminate().catch(() => undefined);
      };
      signal?.addEventListener("abort", abortWorker, { once: true });

      try {
        if (signal?.aborted) throw new Error("OCR cancelled");
        worker = await createWorker(languages, OEM.LSTM_ONLY, { cachePath });
        if (signal?.aborted) throw new Error("OCR cancelled");

        onUpdate?.({
          content: [{ type: "text", text: `Recognizing text in ${basename(imagePath)}...` }],
          details: { imagePath, languages },
        });

        const result = await worker.recognize(imagePath);
        const text = result.data.text.trimEnd();
        const confidence = Number(result.data.confidence) || 0;
        const truncation = truncateHead(text || "(no text detected)", {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });

        let fullOutputPath: string | undefined;
        if (truncation.truncated) {
          const outputDir = join(tmpdir(), "pi-deepseek-harness-ocr");
          await mkdir(outputDir, { recursive: true });
          fullOutputPath = join(outputDir, `${Date.now()}-${toolCallId.replace(/[^a-z0-9_-]/gi, "_")}.txt`);
          await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, text, "utf8"));
        }

        const suffix = fullOutputPath
          ? `\n\n[OCR output truncated. Full text saved to: ${fullOutputPath}]`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `OCR text (${languages}, confidence ${confidence.toFixed(1)}%):\n\n${truncation.content}${suffix}`,
            },
          ],
          details: {
            imagePath,
            languages,
            confidence,
            truncated: truncation.truncated,
            fullOutputPath,
          },
        };
      } finally {
        signal?.removeEventListener("abort", abortWorker);
        if (worker) await worker.terminate().catch(() => undefined);
      }
    },
  });

  function updateStatus(ctx: ExtensionContext): void {
    const mode = activeMode();
    let label = `mode:${mode.label ?? activeModeName}`;
    if (activeModeName === "ferrari") {
      label = ferrariPhase === "executing"
        ? ctx.ui.theme.fg("warning", `mode:ferrari ⚡`)
        : ctx.ui.theme.fg("accent", `mode:ferrari ⏸`);
      ctx.ui.setStatus("deepseek-harness-mode", label);
      return;
    }
    ctx.ui.setStatus(
      "deepseek-harness-mode",
      ctx.ui.theme.fg("accent", label),
    );
  }

  function resetFerrariState(ctx?: ExtensionContext): void {
    ferrariPhase = "planning";
    ferrariPlanText = undefined;
    ferrariPlanPending = false;
    ferrariBuildPending = false;
    ferrariComplete = false;
    if (ctx) updateStatus(ctx);
  }

  function latestFerrariPlan(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as {
        type?: string;
        customType?: string;
        data?: { text?: string };
      };
      if (entry.type === "custom" && entry.customType === "ferrari-workflow-plan") {
        return entry.data?.text;
      }
    }
    return undefined;
  }

  function latestPersistedMode(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as {
        type?: string;
        customType?: string;
        data?: { name?: string };
      };
      if (entry.type === "custom" && entry.customType === "deepseek-harness-mode") {
        return entry.data?.name;
      }
    }
    return undefined;
  }

  function latestPersistedPlan(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as {
        type?: string;
        customType?: string;
        data?: { text?: string };
      };
      if (entry.type === "custom" && entry.customType === "deepseek-harness-plan") {
        return entry.data?.text;
      }
    }
    return undefined;
  }

  function assistantText(message: unknown): string {
    const candidate = message as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
    return candidate.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  function assistantHasToolCall(message: unknown): boolean {
    const candidate = message as {
      role?: string;
      content?: Array<{ type?: string }>;
    };
    return candidate.role === "assistant" && candidate.content?.some((block) => block.type === "toolCall") === true;
  }

  function looksLikePlan(text: string): boolean {
    const numberedSteps = text.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0;
    return /(?:^|\n)#{0,3}\s*(?:implementation\s+)?plan\b/i.test(text) || numberedSteps >= 2;
  }

  async function activateMode(
    name: string,
    ctx: ExtensionContext,
    options: { persist?: boolean; notify?: boolean } = {},
  ): Promise<boolean> {
    const mode = config.modes[name];
    if (!mode) {
      ctx.ui.notify(`Unknown mode "${name}". Available: ${Object.keys(config.modes).join(", ")}`, "error");
      return false;
    }

    const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const stableToolSurface = configuredToolSurface.filter((tool) => availableTools.has(tool));
    const allowedTools = mode.tools.filter((tool) => availableTools.has(tool));
    const missingTools = mode.tools.filter((tool) => !availableTools.has(tool));

    if (missingTools.length > 0) {
      ctx.ui.notify(`Mode "${name}": unavailable tools ignored: ${missingTools.join(", ")}`, "warning");
    }
    if (stableToolSurface.length === 0 || allowedTools.length === 0) {
      ctx.ui.notify(`Mode "${name}" has no available tools and was not activated`, "error");
      return false;
    }

    let modelReady = true;
    const model = ctx.modelRegistry.find(mode.provider, mode.model);
    if (!model) {
      modelReady = false;
      ctx.ui.notify(`Mode "${name}": model ${mode.provider}/${mode.model} not found`, "error");
    } else {
      modelReady = await pi.setModel(model);
      if (!modelReady) {
        ctx.ui.notify(
          `Mode "${name}": authentication unavailable for ${mode.provider}/${mode.model}. Run /login deepseek.`,
          "error",
        );
      }
    }

    activeModeName = name;
    modeNeedsAnnouncement = true;
    pi.setThinkingLevel(mode.thinkingLevel);
    // Keep one stable schema across modes for DeepSeek prefix-cache reuse.
    // Runtime gates below enforce each mode's narrower allowlist.
    pi.setActiveTools(stableToolSurface);

    // Reset Ferrari state when leaving Ferrari mode
    if (name !== "ferrari") {
      resetFerrariState();
    }

    if (options.persist !== false) {
      pi.appendEntry("deepseek-harness-mode", { name });
    }
    updateStatus(ctx);

    if (options.notify !== false) {
      ctx.ui.notify(
        `Mode ${name}: ${mode.provider}/${mode.model}, thinking ${mode.thinkingLevel}, allowed tools ${allowedTools.join(", ")}`,
        modelReady ? "info" : "warning",
      );
    }

    return modelReady;
  }

  async function activateFromCommand(name: string, task: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish before changing mode", "warning");
      return;
    }

    const modelReady = await activateMode(name, ctx);
    if (task.trim()) {
      if (!modelReady) {
        ctx.ui.setEditorText(task.trim());
        ctx.ui.notify("Task restored to the editor; authenticate DeepSeek before submitting it", "warning");
        return;
      }
      pi.sendUserMessage(task.trim());
    }
  }

  async function cycleMode(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current turn to finish before changing mode", "warning");
      return;
    }

    const currentIndex = config.cycle.indexOf(activeModeName);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % config.cycle.length;
    await activateMode(config.cycle[nextIndex], ctx);
  }

  pi.registerCommand("mode", {
    description: "Select or inspect the DeepSeek harness mode",
    getArgumentCompletions: (prefix) => {
      const values = [...Object.keys(config.modes), "status"];
      const matches = values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "status") {
        const mode = activeMode();
        ctx.ui.notify(
          `Mode ${activeModeName}: ${mode.provider}/${mode.model}, thinking ${mode.thinkingLevel}, tools ${mode.tools.join(", ")}`,
          "info",
        );
        return;
      }
      if (requested) {
        await activateFromCommand(requested, "", ctx);
        return;
      }

      const selected = await ctx.ui.select(
        "DeepSeek mode",
        Object.keys(config.modes).map((name) => {
          const mode = config.modes[name];
          const marker = name === activeModeName ? " (active)" : "";
          return `${name}${marker} — ${mode.model}, ${mode.thinkingLevel}`;
        }),
      );
      if (!selected) return;
      await activateFromCommand(selected.split(/\s/)[0], "", ctx);
    },
  });

  for (const name of Object.keys(config.modes)) {
    pi.registerCommand(name, {
      description: `Switch to ${name} mode; optional trailing text is submitted as the task`,
      handler: async (args, ctx) => activateFromCommand(name, args, ctx),
    });
  }

  pi.registerCommand("execute", {
    description: "Confirm and execute the latest plan in build mode",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish before executing a plan", "warning");
        return;
      }

      latestPlanText = latestPlanText ?? latestPersistedPlan(ctx);
      if (!latestPlanText) {
        ctx.ui.notify("No implementation plan found in the active session branch. Create one with /plan first.", "warning");
        return;
      }

      const skipConfirmation = /^(?:--yes|-y|yes)$/i.test(args.trim());
      if (!skipConfirmation) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Use /execute --yes in non-interactive mode", "warning");
          return;
        }
        const preview = latestPlanText.length > 1200 ? `${latestPlanText.slice(0, 1200)}\n…` : latestPlanText;
        const confirmed = await ctx.ui.confirm("Execute latest plan?", `${preview}\n\nSwitch to build mode and continue?`);
        if (!confirmed) return;
      }

      const modelReady = await activateMode("build", ctx);
      if (!modelReady) return;
      const approvedPlan = latestPlanText.slice(0, 80_000);
      pi.sendUserMessage(
        `Execute the following user-approved plan completely. Validate assumptions against the current code, keep scope tight, and run relevant verification.\n\n<approved-plan>\n${approvedPlan}\n</approved-plan>`,
      );
    },
  });

  pi.registerCommand("execute-ferrari", {
    description: "Confirm and execute the latest Ferrari plan in build mode",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish before executing a plan", "warning");
        return;
      }

      ferrariPlanText = ferrariPlanText ?? latestFerrariPlan(ctx);
      if (!ferrariPlanText) {
        ctx.ui.notify(
          "No Ferrari plan found in the active session branch. Run Ferrari first.",
          "warning",
        );
        return;
      }

      const skipConfirmation = /^(?:--yes|-y|yes)$/i.test(args.trim());
      if (!skipConfirmation) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Use /execute-ferrari --yes in non-interactive mode", "warning");
          return;
        }
        const preview = ferrariPlanText.length > 1200
          ? `${ferrariPlanText.slice(0, 1200)}\n…`
          : ferrariPlanText;
        const confirmed = await ctx.ui.confirm(
          "Execute latest Ferrari plan?",
          `${preview}\n\nSwitch to Ferrari build phase and continue?`,
        );
        if (!confirmed) return;
      }

      const modelReady = await activateMode("ferrari", ctx);
      if (!modelReady) return;
      const planSnapshot = ferrariPlanText.slice(0, 80_000);
      ferrariPhase = "executing";
      ferrariBuildPending = true;
      ferrariPlanPending = false;
      ferrariComplete = false;
      updateStatus(ctx);
      pi.sendUserMessage(
        `Exécute le plan Ferrari approuvé.\n\n<approved-plan>\n${planSnapshot}\n</approved-plan>`,
      );
    },
  });

  for (const shortcut of config.cycleShortcuts ?? []) {
    pi.registerShortcut(shortcut, {
      description: "Cycle DeepSeek harness mode",
      handler: cycleMode,
    });
  }

  pi.on("tool_call", (event) => {
    // Block mutation tools in Ferrari planning mode
    if (activeModeName === "ferrari" && ferrariPhase === "planning" && isMutationTool(event.toolName)) {
      return {
        block: true,
        reason: `Ferrari planning: "${event.toolName}" is disabled. Approve the plan first before making changes.`,
      };
    }

    // Blocking mutation tools in read-only modes — suggest alternatives instead of "switch mode"
    const READ_ONLY_MODES = new Set(["brainstorm", "plan"]);
    if (READ_ONLY_MODES.has(activeModeName) && isMutationTool(event.toolName)) {
      return {
        block: true,
        reason: `Mode ${activeModeName}: ${event.toolName} is disabled (this mode is read-only). Use ls, find, grep, or read for code inspection.`,
      };
    }

    const mode = activeMode();
    if (mode.tools.includes(event.toolName)) return;
    const enablingModes = Object.entries(config.modes)
      .filter(([, candidate]) => candidate.tools.includes(event.toolName))
      .map(([name]) => name);
    const hint = enablingModes.length > 0
      ? `Switch to ${enablingModes.join(" or ")} mode before using it.`
      : "No configured mode enables this tool.";
    return {
      block: true,
      reason: `Mode ${activeModeName}: tool "${event.toolName}" is disabled. ${hint}`,
    };
  });

  pi.on("before_agent_start", () => {
    // Ferrari approved-build injection
    if (ferrariBuildPending && activeModeName === "ferrari") {
      ferrariBuildPending = false;
      return {
        message: {
          customType: "ferrari-execute-context",
          content: ferrariBuildInstructions(ferrariPlanText ?? ""),
          display: false,
        },
      };
    }

    // Defensive: clear ferrariBuildPending if we're not in ferrari mode
    if (ferrariBuildPending && activeModeName !== "ferrari") {
      ferrariBuildPending = false;
    }

    if (!modeNeedsAnnouncement) return;
    modeNeedsAnnouncement = false;
    const mode = activeMode();
    return {
      message: {
        customType: "deepseek-harness-mode-context",
        content: `[DEEPSEEK HARNESS MODE: ${activeModeName.toUpperCase()}]\nThese instructions supersede earlier harness-mode instructions.\n\n${mode.instructions}`,
        display: false,
      },
    };
  });

  pi.on("turn_end", (event) => {
    if (activeModeName === "plan" && !assistantHasToolCall(event.message)) {
      const text = assistantText(event.message);
      if (text && looksLikePlan(text)) {
        latestPlanText = text.slice(0, 80_000);
        pi.appendEntry("deepseek-harness-plan", { text: latestPlanText, capturedAt: Date.now() });
      }
    }

    // Ferrari plan detection: capture plans even alongside tool calls —
    // detectFerrariPlan is strict enough (PHASE 2 marker + 3-7 steps + no PHASE 3 + stop marker)
    if (activeModeName === "ferrari" && ferrariPhase === "planning" && !ferrariPlanPending) {
      const text = assistantText(event.message);
      if (!text) return;
      const plan = detectFerrariPlan(text);
      if (plan) {
        ferrariPlanText = plan.rawText.slice(0, 80_000);
        ferrariPlanPending = true;
        pi.appendEntry("ferrari-workflow-plan", { text: ferrariPlanText, capturedAt: Date.now() });
      }
    }

    // Ferrari execution: detect completion marker (accent-insensitive)
    if (activeModeName === "ferrari" && ferrariPhase === "executing" && !ferrariComplete) {
      const text = assistantText(event.message);
      if (text) {
        const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (/FERRARI\s*COMPLETE/i.test(normalized)) {
          ferrariComplete = true;
        }
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Revoke Ferrari execution approval after build completes (detected via FERRARI COMPLETE marker)
    if (activeModeName === "ferrari" && ferrariPhase === "executing" && ferrariComplete) {
      resetFerrariState(ctx);
      return;
    }

    // Show Ferrari plan approval modal
    if (activeModeName !== "ferrari" || !ferrariPlanPending || !ferrariPlanText) return;

    // Snapshot before async to avoid TOCTOU from session_compact / session_tree
    const planSnapshot = ferrariPlanText;

    if (!ctx.hasUI) {
      // Non-interactive: keep plan captured, reset pending so next plan can be detected
      ferrariPlanPending = false;
      ctx.ui.notify(
        "Ferrari plan captured but no UI available. Use /execute-ferrari --yes to run it.",
        "warning",
      );
      return;
    }

    const preview = planSnapshot.length > 1200
      ? `${planSnapshot.slice(0, 1200)}\n…`
      : planSnapshot;

    const choice = await ctx.ui.select("Ferrari — valider le plan", [
      "▶ Exécuter le plan",
      "✏ Réviser (donner un feedback)",
      "✖ Annuler",
    ]);

    // Re-check after await: state could have been reset by compaction/tree/switch
    if (!ferrariPlanPending || ferrariPlanText !== planSnapshot) {
      return;
    }

    if (!choice || choice.startsWith("✖")) {
      ferrariPlanPending = false;
      ferrariPlanText = undefined;
      updateStatus(ctx);
      return;
    }

    if (choice.startsWith("✏")) {
      ferrariPlanPending = false;
      ferrariPlanText = undefined;
      const feedback = await ctx.ui.editor("Feedback pour réviser le plan :", "");
      updateStatus(ctx);
      if (feedback?.trim()) {
        pi.sendUserMessage(
          `Révise le plan précédent avec ce feedback :\n\n${feedback.trim()}`,
        );
      }
      return;
    }

    // Execute: approve and trigger build
    ferrariPlanPending = false;
    ferrariPhase = "executing";
    ferrariBuildPending = true;
    ferrariComplete = false;
    updateStatus(ctx);

    pi.sendUserMessage(
      `Exécute le plan Ferrari approuvé.\n\n<approved-plan>\n${planSnapshot.slice(0, 80_000)}\n</approved-plan>`,
    );
  });

  pi.on("session_compact", () => {
    modeNeedsAnnouncement = true;
    resetFerrariState();
  });

  pi.on("session_tree", () => {
    modeNeedsAnnouncement = true;
    resetFerrariState();
  });

  pi.on("session_start", async (_event, ctx) => {
    const restored = latestPersistedMode(ctx);
    const initialMode = restored && config.modes[restored] ? restored : config.defaultMode;
    latestPlanText = latestPersistedPlan(ctx);
    // Restore Ferrari plan from session (but always start in planning phase)
    ferrariPlanText = latestFerrariPlan(ctx);
    await activateMode(initialMode, ctx, { persist: false, notify: false });
  });
}
