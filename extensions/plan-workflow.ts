export type PlanEffort = "normal" | "max";
export type PlanStatus = "ready" | "executing" | "attempted" | "interrupted";

export interface PlanStep {
  description: string;
  files: string[];
  verification: string;
}

export interface PublishedPlan {
  id: string;
  objective: string;
  steps: PlanStep[];
  risks: string[];
  finalVerification: string[];
  effort: PlanEffort;
  status: PlanStatus;
  createdAt: number;
}

interface SessionLikeEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

const PLAN_ENTRY = "deepseek-harness-plan";
const PLAN_STATE_ENTRY = "deepseek-harness-plan-state";

export function collectPlans(entries: readonly SessionLikeEntry[]): PublishedPlan[] {
  const plans = new Map<string, PublishedPlan>();
  const order: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === PLAN_ENTRY) {
      const candidate = entry.data as PublishedPlan | undefined;
      if (!candidate?.id || !Array.isArray(candidate.steps)) continue;
      plans.set(candidate.id, { ...candidate });
      if (!order.includes(candidate.id)) order.push(candidate.id);
    } else if (entry.customType === PLAN_STATE_ENTRY) {
      const state = entry.data as { id?: string; status?: PlanStatus } | undefined;
      if (!state?.id || !state.status) continue;
      const plan = plans.get(state.id);
      if (plan) plan.status = state.status;
    }
  }

  return order.flatMap((id) => {
    const plan = plans.get(id);
    return plan ? [plan] : [];
  });
}

export function nextPlanId(plans: readonly PublishedPlan[]): string {
  const greatest = plans.reduce((max, plan) => {
    const match = /^P(\d+)$/.exec(plan.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `P${greatest + 1}`;
}

export function selectPlan(plans: readonly PublishedPlan[], requestedId?: string): PublishedPlan | undefined {
  if (requestedId) {
    const normalized = requestedId.trim().toUpperCase().replace(/^#/, "");
    return [...plans].reverse().find((plan) => plan.id.toUpperCase() === normalized);
  }
  return [...plans].reverse().find((plan) => plan.status === "ready" || plan.status === "interrupted");
}

export function formatPlan(plan: PublishedPlan): string {
  const steps = plan.steps
    .map((step, index) => {
      const files = step.files.length > 0 ? step.files.join(", ") : "(none)";
      return `${index + 1}. ${step.description}\n   Files: ${files}\n   Verify: ${step.verification}`;
    })
    .join("\n");
  const risks = plan.risks.length > 0 ? plan.risks.map((risk) => `- ${risk}`).join("\n") : "- None identified";
  const verification = plan.finalVerification.map((item) => `- ${item}`).join("\n") || "- Relevant project checks";
  return `# Plan ${plan.id} — ${plan.objective}\n\n${steps}\n\n## Risks\n${risks}\n\n## Final verification\n${verification}\n\nEffort: ${plan.effort}`;
}

export const planEntryTypes = { plan: PLAN_ENTRY, state: PLAN_STATE_ENTRY } as const;
