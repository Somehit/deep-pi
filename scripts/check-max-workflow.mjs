#!/usr/bin/env node
import { addUsage, emptyUsage, hasMaxSinceLastCompaction, isMaxActive, validateAssignments } from "../extensions/max-workflow.ts";

const valid = [
  { id: "facts", role: "investigator", task: "Verify facts" },
  { id: "break", role: "adversarial", task: "Find counterexamples" },
];
if (validateAssignments(valid)) throw new Error("Valid assignments rejected");
if (!validateAssignments([...valid, valid[0]])) throw new Error("Duplicate id accepted");
if (!validateAssignments([])) throw new Error("Empty round accepted");
if (!isMaxActive([
  { type: "custom", customType: "deepseek-harness-max-state", data: { active: true } },
])) throw new Error("Active Max marker missed");
const completedMax = [
  { type: "custom", customType: "deepseek-harness-max-state", data: { active: true } },
  { type: "custom", customType: "deepseek-harness-max-state", data: { active: false } },
];
if (isMaxActive(completedMax)) throw new Error("Inactive Max marker missed");
if (!hasMaxSinceLastCompaction(completedMax)) throw new Error("Completed Max context was not retained for compaction");
if (hasMaxSinceLastCompaction([...completedMax, { type: "compaction" }])) throw new Error("Compaction did not consume Max marker");
const usage = emptyUsage();
addUsage(usage, { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 5, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } });
if (usage.totalTokens !== 5 || usage.cost.total !== 3) throw new Error("Usage aggregation failed");
console.log("Max workflow: OK");
