#!/usr/bin/env node
import { collectPlans, nextPlanId, selectPlan } from "../extensions/plan-workflow.ts";

const base = {
  objective: "Test",
  steps: [{ description: "Do it", files: ["a.ts"], verification: "npm test" }],
  risks: [],
  finalVerification: ["npm test"],
  effort: "normal",
  status: "ready",
  createdAt: 1,
};
const entries = [
  { type: "custom", customType: "deepseek-harness-plan", data: { ...base, id: "P1" } },
  { type: "custom", customType: "deepseek-harness-plan-state", data: { id: "P1", status: "attempted" } },
  { type: "custom", customType: "deepseek-harness-plan", data: { ...base, id: "P2", effort: "max" } },
];
const plans = collectPlans(entries);
if (plans.length !== 2) throw new Error("Expected two plans");
if (plans[0].status !== "attempted") throw new Error("Plan state was not applied");
if (selectPlan(plans)?.id !== "P2") throw new Error("Latest ready plan was not selected");
if (selectPlan(plans, "#p1")?.id !== "P1") throw new Error("Explicit plan selection failed");
if (nextPlanId(plans) !== "P3") throw new Error("Next plan id failed");
console.log("Plan workflow: OK");
