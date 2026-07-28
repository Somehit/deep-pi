import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { redactSensitiveLines } from "./sensitive-paths.ts";

interface ContextConfig {
  snipThresholdPercent: number;
  pruneThresholdPercent: number;
  compactThresholdPercent: number;
  snipKeepRecentTurns: number;
  pruneKeepRecentTurns: number;
  snipHeadChars: number;
  snipTailChars: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  compactionProvider: string;
  compactionModel: string;
  compactionThinkingLevel: "off" | "high" | "max";
  compactionMaxTokens: number;
}

interface MaintenanceState {
  stage: 0 | 1 | 2;
  cutoffTimestamp?: number;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(packageRoot, "config/context.json"), "utf8")) as ContextConfig;

function restoreState(ctx: ExtensionContext): MaintenanceState {
  let state: MaintenanceState = { stage: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    const candidate = entry as {
      type?: string;
      customType?: string;
      data?: MaintenanceState;
    };
    if (candidate.type === "compaction") state = { stage: 0 };
    if (candidate.type === "custom" && candidate.customType === "deepseek-context-state" && candidate.data) {
      state = candidate.data;
    }
  }
  return state;
}

function cutoffBeforeRecentTurns(messages: Array<{ role?: string; timestamp?: number }>, keepTurns: number): number | undefined {
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "user") continue;
    userTurns++;
    if (userTurns === keepTurns) {
      const timestamp = messages[index].timestamp;
      return typeof timestamp === "number" ? timestamp - 1 : undefined;
    }
  }
  return undefined;
}

function compactOldText(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 200) return text;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n[… ${omitted.toLocaleString()} older tool-result characters omitted; full output remains in the Pi session JSONL …]\n\n${text.slice(-tailChars)}`;
}

function fileOperationDetails(fileOps: unknown): { readFiles: string[]; modifiedFiles: string[] } {
  const operations = fileOps as {
    read?: Set<string>;
    edited?: Set<string>;
    written?: Set<string>;
  };
  const modified = new Set([...(operations.edited ?? []), ...(operations.written ?? [])]);
  const readFiles = [...(operations.read ?? [])].filter((path) => !modified.has(path)).sort();
  return { readFiles, modifiedFiles: [...modified].sort() };
}

function appendFileLists(summary: string, details: { readFiles: string[]; modifiedFiles: string[] }): string {
  const read = details.readFiles.length > 0 ? details.readFiles.join("\n") : "(none)";
  const modified = details.modifiedFiles.length > 0 ? details.modifiedFiles.join("\n") : "(none)";
  return `${summary.trim()}\n\n<read-files>\n${read}\n</read-files>\n\n<modified-files>\n${modified}\n</modified-files>`;
}

export default function deepseekContextExtension(pi: ExtensionAPI): void {
  let state: MaintenanceState = { stage: 0 };
  let compactionRequested = false;

  function persistState(): void {
    pi.appendEntry("deepseek-context-state", state);
  }

  function enterStage(stage: 1 | 2, ctx: ExtensionContext): boolean {
    const messages = ctx.sessionManager.buildSessionContext().messages as Array<{
      role?: string;
      timestamp?: number;
    }>;
    const keepTurns = stage === 1 ? config.snipKeepRecentTurns : config.pruneKeepRecentTurns;
    const cutoffTimestamp = cutoffBeforeRecentTurns(messages, keepTurns);
    if (cutoffTimestamp === undefined) return false;

    state = { stage, cutoffTimestamp };
    persistState();
    const label = stage === 1 ? "snip" : "prune";
    ctx.ui.notify(
      `DeepSeek context maintenance: ${label} stage enabled; older successful tool outputs will be shortened non-destructively.`,
      "info",
    );
    return true;
  }

  pi.on("context", (event) => {
    if (state.stage === 0 || state.cutoffTimestamp === undefined) return;
    const headChars = state.stage === 1 ? config.snipHeadChars : config.pruneHeadChars;
    const tailChars = state.stage === 1 ? config.snipTailChars : config.pruneTailChars;

    return {
      messages: event.messages.map((message) => {
        if (message.role !== "toolResult" || message.isError || message.timestamp > state.cutoffTimestamp!) {
          return message;
        }
        let changed = false;
        const content = message.content.map((block) => {
          if (block.type !== "text") return block;
          const shortened = compactOldText(block.text, headChars, tailChars);
          if (shortened !== block.text) changed = true;
          return shortened === block.text ? block : { ...block, text: shortened };
        });
        return changed ? { ...message, content } : message;
      }),
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null) return;

    if (usage.percent >= config.pruneThresholdPercent && state.stage < 2) {
      enterStage(2, ctx);
    } else if (usage.percent >= config.snipThresholdPercent && state.stage < 1) {
      enterStage(1, ctx);
    }

    if (usage.percent >= config.compactThresholdPercent && !compactionRequested) {
      compactionRequested = true;
      ctx.compact({
        customInstructions:
          "Preserve user requirements, accepted plans, exact file paths, implementation decisions, modified files, test commands/results, blockers, and the next concrete action.",
        onComplete: () => {
          compactionRequested = false;
        },
        onError: (error) => {
          compactionRequested = false;
          ctx.ui.notify(`Proactive DeepSeek compaction failed: ${error.message}`, "warning");
        },
      });
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.modelRegistry.find(config.compactionProvider, config.compactionModel);
    if (!model) {
      ctx.ui.notify("DeepSeek Flash compactor unavailable; falling back to Pi compaction", "warning");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify("DeepSeek Flash compactor authentication unavailable; falling back to Pi compaction", "warning");
      return;
    }

    const { preparation, customInstructions, signal } = event;
    const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    if (messages.length === 0) return;

    const conversation = redactSensitiveLines(serializeConversation(convertToLlm(messages)));
    const previous = preparation.previousSummary
      ? `\n\n<previous-summary>\n${preparation.previousSummary}\n</previous-summary>`
      : "";
    const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
    const prompt = `Create a durable coding-session checkpoint from the conversation below.${previous}${focus}

Use exactly these sections:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Verification
## Next Steps
## Critical Context

Preserve exact file paths, symbols, commands, errors, user-approved plans, and test results. Distinguish completed work from assumptions. Be compact but sufficient for another model to continue without the discarded history.

<conversation>\n${conversation}\n</conversation>`;

    try {
      ctx.ui.notify(
        `Compacting ${preparation.tokensBefore.toLocaleString()} tokens with ${config.compactionModel}...`,
        "info",
      );
      const response = await completeSimple(
        model,
        {
          systemPrompt: "You create precise, loss-minimizing checkpoints for software-engineering sessions.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: config.compactionMaxTokens,
          reasoning: config.compactionThinkingLevel,
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );
      const summary = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!summary) return;

      const details = fileOperationDetails(preparation.fileOps);
      return {
        compaction: {
          summary: appendFileLists(summary, details),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details,
        },
      };
    } catch (error) {
      if (!signal.aborted) {
        ctx.ui.notify(
          `DeepSeek Flash compaction failed; using Pi fallback: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
      return;
    }
  });

  pi.on("session_compact", () => {
    state = { stage: 0 };
    compactionRequested = false;
    persistState();
  });

  pi.on("session_tree", (_event, ctx) => {
    state = restoreState(ctx);
    compactionRequested = false;
  });

  pi.on("session_start", (_event, ctx) => {
    state = restoreState(ctx);
    compactionRequested = false;
  });
}
