#!/usr/bin/env node

import { detectFerrariPlan, hasFerrariStopMarker, isMutationTool } from "../extensions/ferrari-workflow.ts";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

// ── isMutationTool ──────────────────────────────────────────────────

check("bash is mutation tool", isMutationTool("bash"), true);
check("edit is mutation tool", isMutationTool("edit"), true);
check("write is mutation tool", isMutationTool("write"), true);
check("read is not mutation tool", isMutationTool("read"), false);
check("grep is not mutation tool", isMutationTool("grep"), false);
check("find is not mutation tool", isMutationTool("find"), false);
check("ls is not mutation tool", isMutationTool("ls"), false);
check("deepseek_delegate is not mutation tool", isMutationTool("deepseek_delegate"), false);

// ── detectFerrariPlan: positive cases ──────────────────────────────

const validPlan = `### PHASE 1 — EXPLORE
Approche A: avantage X, risque Y.

### PHASE 2 — PLAN
1. [src/foo.ts] Modifier la signature [VÉRIFICATION: npx tsc --noEmit]
2. [src/bar.ts] Mettre à jour l'appelant [VÉRIFICATION: npm test]
3. [tests/foo.test.ts] Ajouter un test [VÉRIFICATION: npm test]
4. [README.md] Documenter le changement [VÉRIFICATION: grep CHANGELOG]

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

const result = detectFerrariPlan(validPlan);
check("detects valid Ferrari plan", result !== null, true);
if (result) {
  check("  step count", result.steps.length, 4);
  check("  step 1", result.steps[0], "1. [src/foo.ts] Modifier la signature [VÉRIFICATION: npx tsc --noEmit]");
  check("  step 4", result.steps[3], "4. [README.md] Documenter le changement [VÉRIFICATION: grep CHANGELOG]");
}

// ── detectFerrariPlan: em-dash variant ─────────────────────────────

const emDashPlan = `### PHASE 2 — PLAN
1. Étape un
2. Étape deux
3. Étape trois

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("detects plan with em-dash", detectFerrariPlan(emDashPlan) !== null, true);

// ── detectFerrariPlan: en-dash variant ─────────────────────────────

const enDashPlan = `### PHASE 2 – PLAN
1. Étape un
2. Étape deux
3. Étape trois

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("detects plan with en-dash", detectFerrariPlan(enDashPlan) !== null, true);

// ── detectFerrariPlan: hyphen variant ──────────────────────────────

const hyphenPlan = `### PHASE 2 - PLAN
1. Étape un
2. Étape deux
3. Étape trois

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("detects plan with hyphen", detectFerrariPlan(hyphenPlan) !== null, true);

// ── detectFerrariPlan: too few steps ───────────────────────────────

const tooFewSteps = `### PHASE 1 — EXPLORE
Approche A.

### PHASE 2 — PLAN
1. Étape un
2. Étape deux

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("rejects plan with only 2 steps", detectFerrariPlan(tooFewSteps), null);

// ── detectFerrariPlan: too many steps ──────────────────────────────

const tooManySteps = `### PHASE 2 — PLAN
1. Un
2. Deux
3. Trois
4. Quatre
5. Cinq
6. Six
7. Sept
8. Huit

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("rejects plan with 8 steps", detectFerrariPlan(tooManySteps), null);

// ── detectFerrariPlan: missing PHASE 2 marker ──────────────────────

const missingPhase2 = `### PHASE 1 — EXPLORE
Just exploring...

1. Step one
2. Step two
3. Step three`;

check("rejects text without PHASE 2 marker", detectFerrariPlan(missingPhase2), null);

// ── detectFerrariPlan: PHASE 3 present ─────────────────────────────

const withPhase3 = `### PHASE 2 — PLAN
1. Étape un
2. Étape deux
3. Étape trois

### PHASE 3 — BUILD
Starting build...

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

check("rejects plan with PHASE 3 present", detectFerrariPlan(withPhase3), null);

// ── detectFerrariPlan: 3 steps (minimum) ───────────────────────────

const threeSteps = `### PHASE 2 — PLAN
1. Étape un [VÉRIFICATION]
2. Étape deux [VÉRIFICATION]
3. Étape trois [VÉRIFICATION]

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

const threeResult = detectFerrariPlan(threeSteps);
check("accepts plan with exactly 3 steps", threeResult !== null, true);
if (threeResult) {
  check("  step count", threeResult.steps.length, 3);
}

// ── detectFerrariPlan: 7 steps (maximum) ───────────────────────────

const sevenSteps = `### PHASE 2 — PLAN
1. Un
2. Deux
3. Trois
4. Quatre
5. Cinq
6. Six
7. Sept

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

const sevenResult = detectFerrariPlan(sevenSteps);
check("accepts plan with exactly 7 steps", sevenResult !== null, true);
if (sevenResult) {
  check("  step count", sevenResult.steps.length, 7);
}

// ── hasFerrariStopMarker ───────────────────────────────────────────

check("detects PLAN TERMINÉ", hasFerrariStopMarker("### ✅ PLAN TERMINÉ — en attente d'approbation."), true);
check("detects attente d'approbation", hasFerrariStopMarker("En attente d'approbation utilisateur..."), true);
check("rejects text without stop marker", hasFerrariStopMarker("1. Step one\n2. Step two"), false);

// ── detectFerrariPlan: plan after PHASE 1 with intervening text ───

const planAfterExplore = `### PHASE 1 — EXPLORE
Scout results here...

### PHASE 2 — PLAN
1. [src/a.ts] Change A [VÉRIFICATION: tsc]
2. [src/b.ts] Change B [VÉRIFICATION: test]
3. [src/c.ts] Change C [VÉRIFICATION: lint]

### ✅ PLAN TERMINÉ — en attente d'approbation.`;

const exploreResult = detectFerrariPlan(planAfterExplore);
check("detects plan after EXPLORE section", exploreResult !== null, true);

// ── detectFerrariPlan: missing stop marker ─────────────────────────

const noStopMarker = `### PHASE 2 — PLAN
1. Étape un
2. Étape deux
3. Étape trois`;

check("rejects plan without stop marker", detectFerrariPlan(noStopMarker), null);

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
