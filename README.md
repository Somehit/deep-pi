# Harness Pi natif DeepSeek

Configuration Pi locale et portable avec trois modes : **brainstorm**, **plan** et **build**.

## Installation

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

L'installateur :

1. vérifie la configuration ;
2. sauvegarde `~/.pi/agent/settings.json` ;
3. enregistre ce dossier comme package Pi local global ;
4. fusionne `config/settings.json` dans les settings globaux ;
5. ne copie et ne stocke aucune clé API.

Pour conserver tes defaults Pi actuels :

```bash
./install.sh --no-defaults
```

Si nécessaire, lance ensuite Pi et exécute :

```text
/login deepseek
```

## Modes

| Mode | Modèle par défaut | Thinking | Outils | Usage |
|---|---|---:|---|---|
| brainstorm | `deepseek-v4-flash` | max | lecture/recherche + OCR | Explorer des options et compromis |
| plan | `deepseek-v4-pro` | max | lecture/recherche + interview | Clarifier les zones de flou puis produire un plan fondé sur le code |
| build | `deepseek-v4-pro` | high | lecture, shell, édition | Implémenter et vérifier |

Commandes :

```text
/brainstorm
/brainstorm concevoir le système de cache
/plan
/plan préparer la migration de l'API
/build
/build appliquer le plan validé
/execute            # confirmer et exécuter le dernier plan capturé
/execute --yes      # sans confirmation interactive
/scout <recherche>
/review [focus]
/mode               # sélecteur
/mode status
/mode plan
```

Raccourcis pour cycler :

- `Ctrl+Alt+M`
- `F6`

Dans l'éditeur principal, `Tab` reste volontairement réservé à l'autocomplétion Pi ; l'interview l'utilise localement pour ses onglets. Les combinaisons `Ctrl+Shift+lettre` sont également ambiguës dans de nombreux terminaux ; `F6` constitue le fallback fiable.

## Interview interactif du mode plan

Après sa reconnaissance en lecture seule, le mode plan appelle automatiquement `plan_interview` lorsqu'une décision utilisateur peut modifier matériellement la solution. Il n'ouvre pas d'interview cérémoniel si la demande et le code fournissent déjà toutes les réponses.

L'interface regroupe jusqu'à quatre questions dans des onglets et propose :

- des options numérotées avec descriptions et recommandation éventuelle ;
- une réponse libre via **Type something** ;
- **Chat about this** pour revenir à la conversation avant de décider ;
- navigation clavier avec les raccourcis de sélection Pi, `Tab`/flèches entre questions et chiffres pour choisir directement.

Les réponses reviennent comme résultat d'outil et restent donc dans l'historique de session. L'outil est autorisé uniquement en mode plan ; les garde-fous lecture seule restent inchangés. En RPC, il utilise les dialogues Pi standards. En mode print/JSON sans interface, l'agent reçoit l'instruction de poser les mêmes questions en texte.

## Handoff plan → build

Toute réponse structurée produite en mode plan est enregistrée comme dernier plan de la branche active. `/execute` :

1. affiche un aperçu et demande confirmation ;
2. passe en mode build ;
3. transmet le plan approuvé à Pro ;
4. demande son exécution complète avec vérification.

Le plan est stocké dans une entrée de session Pi qui ne gonfle pas le contexte tant qu'il n'est pas exécuté.

## Sous-agents DeepSeek

Deux sous-agents lancent des processus Pi sans session et avec un contexte isolé :

| Commande / rôle | Modèle | Accès | Contexte fourni |
|---|---|---|---|
| `/scout` / `scout` | Flash + max | read, grep, find, ls | dépôt + tâche bornée |
| `/review` / `reviewer` | Pro + max | read, grep, find, ls | dépôt + status/diff Git collecté par le parent |

Le modèle principal peut aussi les appeler via l'outil stable `deepseek_delegate`. Les enfants ne chargent ni les autres extensions, ni les skills ; seule la protection `.env`/SSH est explicitement conservée. Leur consommation est remontée dans les totaux lorsqu'ils sont appelés comme outil.

## OCR local

Le package fournit le skill :

```text
/skill:ocr ./capture.png
/skill:ocr ./scan.jpg eng
/skill:ocr ./document.png fra+eng
```

Le skill appelle l'outil structuré `ocr_image`, disponible dans les trois modes. Contrairement à l'ancien skill Reasonix :

- aucune commande `node -e` n'est construite avec un chemin injecté ;
- `tesseract.js` est installé dans ce package, pas dans le workspace analysé ;
- les données linguistiques sont mises en cache dans `~/.cache/pi-deepseek-harness/tesseract/` ;
- le résultat est tronqué à la limite Pi et le texte complet est sauvegardé temporairement si nécessaire.

Le premier OCR d'une langue nécessite une connexion réseau pour télécharger ses données Tesseract. L'OCR reste local ensuite. Le réglage `images.blockImages` n'empêche pas cet outil de fonctionner : l'image n'est pas envoyée à DeepSeek, seul le texte extrait lui est retourné.

## Personnalisation

- Modèles, outils et raccourcis : [`config/harness.json`](config/harness.json)
- Maintenance du contexte : [`config/context.json`](config/context.json)
- Settings installés par défaut : [`config/settings.json`](config/settings.json)
- Prompts des modes et sous-agents : [`instructions/`](instructions/)

Après une modification, exécuter `/reload` dans Pi. Relancer `./install.sh` seulement si `config/settings.json` doit être réappliqué ou si le dossier a été déplacé.

Validation manuelle :

```bash
npm run check
```

## Choix cache-first

- Le catalogue natif de Pi est utilisé : aucun `models.json` ne remplace les métadonnées DeepSeek.
- Plan et build utilisent Pro ; brainstorm utilise volontairement Flash avec thinking `max`.
- Le schéma envoyé au modèle reste stable : l'union des outils, dont `ocr_image`, `deepseek_delegate` et `plan_interview`, est chargée une fois, puis l'extension bloque à l'exécution ceux que le mode n'autorise pas.
- Les instructions de mode sont ajoutées en fin de contexte au lieu de reconstruire le prompt système.
- À 55 %, les anciens résultats d'outils réussis sont raccourcis en gardant leur début et leur fin ; les 8 derniers tours restent intacts.
- À 65 %, une réduction plus forte conserve les 5 derniers tours. Les erreurs ne sont jamais réduites.
- À 75 %, une compaction structurée est générée avec Flash/high. L'historique intégral reste dans le JSONL.
- Les notices de cache miss sont activées.
- Brainstorm et plan bloquent effectivement `bash`, `edit` et `write`, même si leurs schémas restent visibles pour préserver le cache.

Un changement plan ↔ build conserve le même modèle et reste favorable au cache. Passer vers ou depuis brainstorm change de modèle et utilise donc un cache distinct. Il reste préférable de ne pas cycler inutilement.

## Protection `.env` et SSH

Le garde global refuse les chemins `.env`, `.env.*` et tout chemin sous `~/.ssh` pour `read`, `write`, `edit`, `grep`, `find`, `ls` et `ocr_image`. Il bloque aussi les commandes Bash qui référencent explicitement ces chemins et filtre les lignes sensibles qui remonteraient d'une recherche large.

Cette protection est volontairement limitée : elle ne restreint ni le réseau, ni les autres fichiers, ni les écritures ordinaires. C'est une barrière de politique du harness, pas une isolation OS complète ; une commande shell volontairement obfusquée peut contourner une analyse textuelle. Pour du code non fiable ou une exécution autonome non supervisée, utiliser Docker ou un véritable sandbox OS.

## Données volontairement externes au dépôt

Les éléments suivants restent gérés par Pi :

- secrets : `~/.pi/agent/auth.json` ou `DEEPSEEK_API_KEY` ;
- sessions : `~/.pi/agent/sessions/` ;
- inscription du chemin local : `~/.pi/agent/settings.json`.

Le code et tous les réglages déclaratifs du harness restent dans ce dossier. Après un clone sur une nouvelle machine, il suffit de relancer `./install.sh`.

## Désinstallation

```bash
./uninstall.sh
```

La désinstallation retire le package mais ne devine pas quels anciens defaults restaurer. Les sauvegardes de settings sont conservées dans `~/.pi/agent/backups/pi-deepseek-harness/`.
