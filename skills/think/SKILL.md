---
name: think
description: >
  Deep multi-source web research protocol. ALWAYS load this skill before answering
  when the topic involves: software versions released after early 2025, unfamiliar
  technical terms or acronyms, current information requests, recent events, niche
  or complex topics where your knowledge may be incomplete, or any fact requiring
  verification. When in doubt about your own knowledge, load this skill immediately.
  Never answer a speculative question on current or uncertain topics without
  researching first. Use web_search systematically.
---

# Think — Deep Research Protocol

Quand ce skill est chargé, tu DOIS suivre ce protocole avant de donner ta réponse finale.
Ne réponds JAMAIS sans avoir complété au moins la phase d'exploration.

## Phase 1 — Évaluation initiale

1. Le sujet nécessite-t-il des informations récentes ou vérifiées ?
2. Ai-je une confiance ≥ 90% dans ma réponse sans recherche ?
3. Si doute sur l'une ou l'autre → passe à la Phase 2.

## Phase 2 — Exploration large (obligatoire)

Génère **1 à 3 requêtes** `web_search` sous des angles différents. Privilégie les sources officielles (docs, changelogs, release notes) avant les sources secondaires. Exemples d'angles :
- Documentation officielle / changelog / release notes
- Limitations, bugs connus, controverses
- Alternatives et contexte historique (si pertinent)

**Règle :** ne te contente JAMAIS d'une seule recherche si plusieurs angles sont pertinents. Mais ne lance pas plus de 3 recherches — la concision prime.

## Phase 3 — Analyse des résultats

Après avoir reçu les résultats :
1. Identifie les points de consensus entre sources
2. Repère les contradictions
3. Note les lacunes (questions sans réponse)
4. Évalue la qualité des sources (officielle > presse spécialisée > blog personnel > forum)

## Phase 4 — Recherche ciblée (si nécessaire)

Si des lacunes ou contradictions persistent, lance 1 à 2 recherches supplémentaires pour les combler.
Un seul round complémentaire maximum — ensuite, synthétise avec les informations disponibles.

## Phase 5 — Synthèse

Produis une réponse structurée :

1. **Résumé** — 2-3 phrases qui capturent l'essentiel
2. **Détails** — explications organisées par thème, avec citations markdown `[source](url)`
3. **Fiabilité** — pour chaque affirmation clé, indique ton niveau de confiance :
   - 🟢 Haute (plusieurs sources officielles concordantes)
   - 🟡 Moyenne (sources secondaires ou avis partagés)
   - 🔴 Faible (source unique, forum, ou absence d'information)
4. **Zones d'ombre** — questions non résolues ou informations manquantes

## Règles absolues

- **Toujours citer** chaque source avec un lien markdown
- **Toujours dater** les informations (version, date de publication)
- **Jamais inventer** — si l'information est introuvable, le dire explicitement
- **Être concis** — la recherche approfondie ne veut pas dire réponse interminable
