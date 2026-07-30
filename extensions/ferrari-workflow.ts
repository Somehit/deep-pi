/**
 * Pure helper functions for Ferrari workflow.
 * Extracted for testability — no extension API dependencies.
 */

const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);

export function isMutationTool(name: string): boolean {
  return MUTATION_TOOLS.has(name);
}

export interface FerrariPlan {
  steps: string[];
  rawText: string;
}

/**
 * Detect a completed Ferrari plan in assistant text.
 * Requirements:
 * - PHASE 2 (PLAN) marker present
 * - PHASE 3 (BUILD) marker NOT present (agent stopped correctly)
 * - 3-7 numbered steps under the plan section
 */
export function detectFerrariPlan(text: string): FerrariPlan | null {
  if (!/###\s*PHASE\s*2\s*[—–\-]\s*PLAN/i.test(text)) return null;
  if (/###\s*PHASE\s*3\s*[—–\-]\s*BUILD/i.test(text)) return null;
  if (!hasFerrariStopMarker(text)) return null;

  // Find steps after the PHASE 2 header
  const phase2Match = text.match(/###\s*PHASE\s*2\s*[—–\-]\s*PLAN.*$/im);
  if (!phase2Match) return null;

  const afterPhase2 = text.slice(text.indexOf(phase2Match[0]) + phase2Match[0].length);
  const stepMatches = [...afterPhase2.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)];

  if (stepMatches.length < 3 || stepMatches.length > 7) return null;

  const steps = stepMatches.map((m) => `${m[1]}. ${m[2].trim()}`);
  return { steps, rawText: text };
}

/**
 * Check whether a Ferrari plan was explicitly terminated by the agent
 * (the agent included the required stop marker).
 */
export function hasFerrariStopMarker(text: string): boolean {
  // Strip diacritics for accent-insensitive matching (Flash may drop accents)
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /PLAN\s*TERMIN[EÉ]/i.test(normalized) || /en\s+attente\s+d.approbation/i.test(normalized);
}

/**
 * Build instructions injected after user approval.
 * These are separate from instructions/ferrari.md so the planning
 * agent never sees the BUILD / VERIFY phases.
 */
export function ferrariBuildInstructions(planText: string): string {
  const trimmed = planText.slice(0, 80_000);
  return `[FERRARI BUILD PHASE — PLAN APPROUVÉ]

Le plan suivant a été approuvé par l'utilisateur.
Exécute-le intégralement. Ne repasse PAS par PHASE 1 ou PHASE 2.

<approved-plan>
${trimmed}
</approved-plan>

### PHASE 3 — BUILD
Objectif : implémenter, étape par étape.
- Une seule étape à la fois.
- Après chaque étape : exécute la commande de vérification.
- Si échec : corrige. N'avance PAS tant que l'étape n'est pas verte.
- Code concis. Pas de commentaires évidents. Pas de code mort.
- Après l'étape N, affiche : ✅ Étape N OK
- **Si 3 tentatives échouent sur la même étape → STOP.** Dis ⚠️ BLOQUÉ : [raison] et suggère de passer en mode Pro.

### PHASE 4 — VERIFY
Objectif : ne rien laisser passer. Cette phase est OBLIGATOIRE.
1. Appelle deepseek_delegate avec role="reviewer-flash" et une description de ce qui a été changé et pourquoi.
2. Appelle deepseek_delegate avec role="adversarial-flash" et demande-lui de trouver des contre-exemples.
3. Pour chaque problème trouvé :
   - Réel → corrige, puis revérifie.
   - Faux positif → documente pourquoi.
4. Si tout est clean → ✅ FERRARI COMPLETE et résumé de ce qui a été fait.`;
}
