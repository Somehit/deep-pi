# Harness Pi natif DeepSeek

Configuration Pi locale, cache-conscious et portable avec deux modes persistants — **Instant** et **Think** — plus le workflow transversal **`/max`**.

## Installation

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

L’installateur vérifie Node, npm, Git et la configuration, sauvegarde les settings Pi, installe ce dossier comme package local et fusionne `config/settings.json`. Il ne copie aucune clé API.

```text
/login deepseek
```

Utiliser `./install.sh --no-defaults` pour ne pas modifier les defaults globaux. Après une modification du package, utiliser `/reload` ; relancer l’installation seulement pour réappliquer les settings.

## Les deux modes

| Mode | Modèle | Thinking | Comportement |
|---|---|---:|---|
| Instant (défaut) | `deepseek-v4-flash` | high | Questions simples et changements explicitement demandés, sans plan cérémoniel |
| Think | `deepseek-v4-pro` | high | Recherche, réflexion et plans structurés ; workspace read-only hors `/execute` |

Changer de mode avec `Ctrl+Alt+M`, `F6`, `/think`, `/instant`, ou `/mode`. Les commandes de mode acceptent une tâche optionnelle (`/think analyser…`). `/status` et `/mode status` affichent le mode et le dernier plan ; `/diff` affiche le status/diff Git après redaction des chemins sensibles.

Le schéma d’outils reste stable pour favoriser le prefix cache DeepSeek. Une gate runtime bloque néanmoins chaque outil non autorisé.

## Plans Think et `/execute`

Think publie un plan avec l’outil structuré `publish_plan`. Chaque plan possède un ID et un effort `normal` ou `max`.

```text
/execute             # dernier plan prêt
/execute P3          # plan explicite
/execute P3 --yes    # sans confirmation interactive
```

L’exécution reste dans Think : `bash`, `edit` et `write` sont déverrouillés pour ce run uniquement, puis reverrouillés à la fin ou après interruption. Un plan publié sous `/max` réactive automatiquement Pro/max pendant son exécution.

## `/max` — conseil Pro/max

`/max` n’est pas un mode : il s’exécute ponctuellement au-dessus du mode courant.

```text
/max analyser cette migration critique
```

- parent et workers : `deepseek-v4-pro`, thinking `max` ;
- workers indépendants et read-only : investigator, solver, critic, adversarial, verifier ;
- rounds parallèles, synthèse par preuves et contre-exemples, jamais par vote ;
- nouveaux rounds seulement sur les désaccords ou risques critiques non résolus ;
- Think + Max reste read-only ; Instant + Max conserve les mutations explicitement demandées ;
- le modèle normal est restauré après le run, une erreur ou une interruption.

Une compaction qui doit encore résumer un run Max utilise Pro/max, même juste après sa fin. Une fois ce contexte Max compacté, les compactages suivants reviennent à Flash/high.

## Undo et redo par prompt

```text
/undo
/redo
/undo --force         # accepter un drift sur les chemins concernés
```

Avant chaque prompt, le harness crée un snapshot Git dans un dépôt isolé sous le répertoire de données local. `/undo` :

1. remonte la conversation avant le dernier message utilisateur ;
2. replace le prompt dans l’éditeur via l’arbre de session Pi ;
3. restaure seulement les chemins versionnables modifiés par ce prompt ;
4. préserve les changements ultérieurs sans rapport ;
5. supporte plusieurs undo, puis redo dans l’ordre inverse.

Une nouvelle requête invalide redo. En cas de drift sur un chemin touché, une confirmation est demandée. Si le snapshot initial échoue, le tour reste read-only au lieu de muter sans filet.

### Portée du rollback

Sont restaurés : fichiers non ignorés, créations, suppressions, renommages, liens et conversation active.

Ne sont pas garantis : fichiers ignorés modifiés par Bash, commits et refs Git, sous-dépôts, déploiements, bases, publications API et autres effets externes. Après un prompt Bash, `/undo` rappelle cette limite. Les objets de snapshot sont ancrés par refs ; aucun nettoyage automatique destructeur n’est effectué.

Les snapshots excluent toujours `.env`, `.env.*` et `.ssh`.

## Sous-agents

```text
/scout <recherche>          # Flash/high, read-only
/review [focus]             # Pro/max, diff Git
/review-flash [focus]       # Flash/high
/adversarial-flash [focus]  # Flash/high
```

L’outil `deepseek_delegate` expose les mêmes rôles aux agents principaux. Les usages imbriqués sont remontés dans les statistiques de session.

## OCR local

```text
/skill:ocr ./capture.png
/skill:ocr ./scan.jpg eng
/skill:ocr ./document.png fra+eng
```

Tesseract fonctionne localement ; seules les données linguistiques du premier lancement sont téléchargées. L’image n’est pas envoyée à DeepSeek.

## Contexte et métriques

- 55 % : réduction non destructive des anciens tool results ;
- 65 % : réduction plus forte ;
- 75 % : compaction structurée ;
- Flash/high normalement, Pro/max tant qu’un run Max non encore compacté reste dans la branche ;
- `/efficiency` affiche tokens, cache, coûts, outils, delegates et rounds Max.

Configuration :

- modes et outils : `config/harness.json` ;
- compaction : `config/context.json` ;
- defaults : `config/settings.json` ;
- instructions : `instructions/`.

## Validation

```bash
npm run lint
npm test
npm run check
```

Les tests hors ligne couvrent configuration, garde sensible, cycle des plans, état Max, agrégation d’usage et snapshots temporaires avec création, suppression, Unicode, espaces, symlink et redo.

## Protection sensible

Le garde global bloque la lecture, recherche, édition et référence explicite de `.env`, `.env.*` et `~/.ssh`, puis filtre ces chemins des sorties Git. Cette barrière n’est pas une sandbox OS ; utiliser un conteneur pour du code non fiable.

## Migration depuis la version quatre modes

Les anciens modes Brainstorm, Plan, Build et Ferrari, leurs commandes et `/execute-ferrari` ont été supprimés. Une session contenant un ancien mode revient sur Instant. Les anciens plans détectés par heuristique ne sont pas exécutables : Think doit les republier avec `publish_plan`.

## Désinstallation

```bash
./uninstall.sh
```

Les defaults globaux et les sauvegardes restent volontairement intacts.
