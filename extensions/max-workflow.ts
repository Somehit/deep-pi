import type { Usage } from "@earendil-works/pi-ai";

export const MAX_STATE_ENTRY = "deepseek-harness-max-state";
export const MAX_ROLES = ["investigator", "solver", "critic", "adversarial", "verifier"] as const;
export type MaxRole = (typeof MAX_ROLES)[number];

export interface MaxAssignment {
  id: string;
  role: MaxRole;
  task: string;
}

export interface MaxState {
  active: boolean;
  runId: string;
  originMode: string;
  reason?: "command" | "plan-execution";
  timestamp: number;
}

export function isMaxActive(entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>): boolean {
  let active = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MAX_STATE_ENTRY) continue;
    const state = entry.data as Partial<MaxState> | undefined;
    if (typeof state?.active === "boolean") active = state.active;
  }
  return active;
}

export function hasMaxSinceLastCompaction(entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>): boolean {
  let seen = false;
  for (const entry of entries) {
    if (entry.type === "compaction") seen = false;
    if (entry.type === "custom" && entry.customType === MAX_STATE_ENTRY) seen = true;
  }
  return seen;
}

export function validateAssignments(assignments: readonly MaxAssignment[], limit = 12): string | undefined {
  if (assignments.length === 0) return "At least one assignment is required";
  if (assignments.length > limit) return `A round supports at most ${limit} assignments`;
  const ids = new Set<string>();
  for (const assignment of assignments) {
    if (!assignment.id.trim()) return "Every assignment needs a non-empty id";
    if (ids.has(assignment.id)) return `Duplicate assignment id: ${assignment.id}`;
    ids.add(assignment.id);
    if (!MAX_ROLES.includes(assignment.role)) return `Unknown Max role: ${assignment.role}`;
    if (!assignment.task.trim()) return `Assignment ${assignment.id} has an empty task`;
  }
  return undefined;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, usage: Usage | undefined): Usage {
  if (!usage) return total;
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
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  return total;
}

export function maxWorkerInstructions(role: MaxRole, base: string): string {
  return `${base}\n\nYour assigned council role is ${role.toUpperCase()}.\n${roleDirective(role)}`;
}

function roleDirective(role: MaxRole): string {
  switch (role) {
    case "investigator": return "Collect independent facts and primary evidence. Separate verified facts from uncertainty.";
    case "solver": return "Develop a complete candidate solution and expose its assumptions and failure modes.";
    case "critic": return "Challenge candidate reasoning, omissions, correlated assumptions, and trade-offs. Do not vote.";
    case "adversarial": return "Construct concrete counterexamples and attempt to falsify every consequential claim.";
    case "verifier": return "Re-check decisive claims against code or sources and report what remains unverified.";
  }
}
