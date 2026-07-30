import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

// ---------- types ----------

interface ToolStats {
  calls: number;
  tokens: number;
}

interface SessionStats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  totalCost: number;
  toolCounts: Record<string, number>;
  specialTools: Record<string, ToolStats>;
  compactions: number;
  compactionTokens: number;
  modelName: string;
  thinkingLevel: string;
}

// ---------- helpers ----------

function emptyStats(): SessionStats {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    totalCost: 0,
    toolCounts: {},
    specialTools: {},
    compactions: 0,
    compactionTokens: 0,
    modelName: "",
    thinkingLevel: "",
  };
}

function addTurnUsage(s: SessionStats, usage: Usage | undefined): void {
  if (!usage) return;
  s.input += usage.input || 0;
  s.output += usage.output || 0;
  s.cacheRead += usage.cacheRead || 0;
  s.cacheWrite += usage.cacheWrite || 0;
  if (usage.reasoning !== undefined) s.reasoning += usage.reasoning;
  s.totalTokens += usage.totalTokens || 0;
  s.totalCost += usage.cost?.total || 0;
}

function addSpecialTool(stats: SessionStats, name: string, usage: Usage | undefined): void {
  const entry = stats.specialTools[name] ?? { calls: 0, tokens: 0 };
  entry.calls++;
  if (usage) entry.tokens += usage.totalTokens || 0;
  stats.specialTools[name] = entry;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatReport(
  s: SessionStats,
  ctxUsage: { tokens: number | null; contextWindow: number; percent: number | null },
): string[] {
  const lines: string[] = [];
  const model = s.turns > 0 && s.modelName ? `${s.modelName} (${s.thinkingLevel})` : "no activity yet";
  const pct =
    ctxUsage.percent !== null
      ? `${ctxUsage.percent}% (${formatNumber(ctxUsage.tokens ?? 0)} / ${formatNumber(ctxUsage.contextWindow)})`
      : "unknown";

  lines.push("─────────────────────────────────────────────────");
  lines.push(`📊 Session Efficiency · ${model}`);
  lines.push("─────────────────────────────────────────────────");
  lines.push(`Turns  ${formatNumber(s.turns)}    Context  ${pct}`);
  lines.push("");
  lines.push("Tokens");
  lines.push(
    `  Input     ${formatNumber(s.input)}  (cache hit: ${formatNumber(s.cacheRead)} · miss: ${formatNumber(s.input - s.cacheRead)})`,
  );
  lines.push(
    `  Output    ${formatNumber(s.output)}  (reasoning: ${formatNumber(s.reasoning)})`,
  );
  lines.push(`  Total     ${formatNumber(s.totalTokens)}`);
  lines.push(`Cost       $${s.totalCost.toFixed(4)}`);
  lines.push("");

  // Tools
  const toolEntries = Object.entries(s.toolCounts).sort(([, a], [, b]) => b - a);
  if (toolEntries.length > 0) {
    lines.push("Tools  " + toolEntries.map(([name, count]) => `${name}:${count}`).join("  "));
  }

  // Special tools (web_search, delegate)
  const specialEntries = Object.entries(s.specialTools);
  if (specialEntries.length > 0) {
    lines.push(
      "       " +
        specialEntries
          .map(([name, t]) => `${name}:${t.calls} (${formatNumber(t.tokens)} tok)`)
          .join("  "),
    );
  }

  if (s.compactions > 0) {
    lines.push("");
    lines.push(`Compactions  ${s.compactions}  (${formatNumber(s.compactionTokens)} tokens)`);
  }

  lines.push("─────────────────────────────────────────────────");
  return lines;
}

// ---------- extension ----------

export default function deepseekEfficiency(pi: ExtensionAPI): void {
  let stats = emptyStats();

  function persist(): void {
    pi.appendEntry("deepseek-efficiency", { ...stats });
  }

  function restore(ctx: ExtensionContext): void {
    let restored = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      const candidate = entry as { type?: string; customType?: string; data?: SessionStats };
      if (candidate.type === "custom" && candidate.customType === "deepseek-efficiency" && candidate.data) {
        stats = candidate.data;
        restored = true;
      }
    }
    if (!restored) stats = emptyStats();
  }

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    stats.turns++;
    addTurnUsage(stats, msg.usage);

    // Capture model/thinking from the first turn that has them
    if (!stats.modelName && msg.model) stats.modelName = msg.model;
    if (!stats.thinkingLevel && ctx.thinkingLevel) stats.thinkingLevel = ctx.thinkingLevel;

    for (const tr of event.toolResults) {
      stats.toolCounts[tr.toolName] = (stats.toolCounts[tr.toolName] ?? 0) + 1;
      if (tr.toolName === "web_search" || tr.toolName === "deepseek_delegate") {
        addSpecialTool(stats, tr.toolName, tr.usage);
      }
    }
  });

  pi.on("session_compact", (event) => {
    stats.compactions++;
    const entry = event.compactionEntry as { usage?: Usage };
    if (entry.usage) {
      stats.compactionTokens += entry.usage.totalTokens || 0;
      stats.totalCost += entry.usage.cost?.total || 0;
    }
  });

  pi.on("agent_settled", () => {
    persist();
  });

  pi.on("session_shutdown", () => {
    persist();
  });

  pi.registerCommand("efficiency", {
    description: "Show session token and cost efficiency metrics",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const contextUsage = ctx.getContextUsage();
      const ctxUsage = contextUsage ?? { tokens: null, contextWindow: 0, percent: null };
      const lines = formatReport(stats, ctxUsage);
      ctx.ui.setWidget("efficiency", lines);
    },
  });
}
