# Persistance des sessions et versions sur disque

**Date :** 2026-07-12 · **Statut :** validé · **Roadmap :** item n°1 du PROJET.md

## Problème

Les versions générées vivent uniquement dans un tableau JS en mémoire navigateur
(`versions[]` dans `public/index.html`). Tout est perdu au restart du serveur
comme au simple refresh de la page. Le serveur est sans état.

## Décisions validées

1. **Organisation en sessions de design** : chaque suite d'itérations forme une
   session avec ses versions. L'UI permet de démarrer un nouveau design et de
   recharger les sessions passées. Prépare la roadmap n°2 (design systems par projet).
2. **Le serveur est la source de vérité** : le front n'envoie plus le HTML courant
   ni l'historique, seulement `sessionId + prompt (+ versionIndex)`. Le serveur
   stocke, reconstruit le contexte et sauvegarde après chaque génération.

## Modèle de données et stockage

Un dossier `data/sessions/` (ajouté au `.gitignore`), **un fichier JSON par session** :

```json
{
  "id": "s_1720735200_ab3f",
  "title": "Dashboard de suivi des API",
  "createdAt": "2026-07-12T10:00:00Z",
  "updatedAt": "2026-07-12T10:05:00Z",
  "versions": [
    { "prompt": "…", "html": "…", "createdAt": "…" }
  ]
}
```

- `title` = premier prompt de la session, tronqué (~80 caractères).
- `id` = `s_<timestamp>_<suffixe aléatoire hexa>`, généré côté serveur, validé par
  regex stricte (`^s_[0-9]+_[0-9a-f]+$`) à chaque lecture pour interdire tout
  path traversal.
- Un fichier par session : écritures plus petites, une session corrompue ne
  détruit pas les autres.
- **Écriture atomique** : écriture dans un fichier temporaire du même dossier puis
  `fs.rename` — survit à un kill en pleine écriture.
- Aucune dépendance ajoutée : `fs/promises` suffit (conforme PROJET.md).

## API serveur

### `POST /api/generate` (évolue)

Reçoit `{ sessionId?, prompt, versionIndex? }`.

- Sans `sessionId` → le serveur crée la session (id, titre, dates).
- Relit depuis le disque le HTML de la version active (`versionIndex`, défaut :
  dernière) et les prompts passés, construit les `messages` **exactement comme
  aujourd'hui** (system prompt + 6 derniers prompts + HTML courant + instruction).
- Appelle le portail IAG **sans toucher au flux stream-tolérant** : `stream: true`,
  `consumeStreamTolerantly`, `extractHtml` restent intacts (contraintes gateway
  du PROJET.md).
- En cas de succès : ajoute la version au JSON, met à jour `updatedAt`, sauvegarde
  atomiquement, renvoie `{ sessionId, version: { prompt, html, createdAt }, versionIndex }`.
- En cas d'échec (portail, timeout, HTML inexploitable) : **rien n'est écrit sur
  disque**, la session reste dans son état précédent.

### Endpoints sessions

- `GET /api/sessions` — liste `[{ id, title, createdAt, updatedAt, versionCount }]`
  triée par `updatedAt` décroissant. Sans les HTML (léger).
- `GET /api/sessions/:id` — session complète avec les HTML, pour recharger l'UI.
- `DELETE /api/sessions/:id` — supprime le fichier. Pas de renommage, pas de
  branches : YAGNI.

## Front (`public/index.html`)

- Panneau gauche : nouvelle section **Sessions** au-dessus des versions —
  bouton « Nouveau design », liste des sessions passées (titre + date relative),
  bouton de suppression par session. Clic → charge la session via
  `GET /api/sessions/:id`, affiche ses versions, sélectionne la dernière.
- Le tableau `versions[]` local devient un simple cache d'affichage de la session
  chargée ; le serveur fait foi. `generate()` envoie
  `{ sessionId, prompt, versionIndex: activeIndex }` et pousse la version renvoyée.
- Au chargement de la page : `GET /api/sessions`, rechargement automatique de la
  session la plus récente → un refresh navigateur ne perd plus rien.
- La préview reste en **Blob URL** (contrainte n°3 du PROJET.md).
- Style : mêmes variables `:root`, dark minimaliste. RGAA : boutons focusables,
  labels/aria, contrastes AA. UI en français.

## Erreurs et cas limites

- Session introuvable (fichier supprimé à la main) → 404 avec message en
  français ; le front retire l'entrée de sa liste.
- Fichier JSON corrompu → session ignorée au listing avec `console.error`,
  les autres sessions se chargent normalement.
- `sessionId` malformé → 400 (validation regex, anti path traversal).
- `versionIndex` hors bornes → défaut sur la dernière version.

## Tests

1. **Mock gateway sale** (procédure PROJET.md) : mock Express sur `:9999`
   streamant des chunks avec ids aléatoires, rafales bufferisées, bruit SSE,
   chunk usage-only. Lancer avec `IAG_BASE_URL=http://localhost:9999/v1`.
2. Scénario bout en bout : générer → itérer → **tuer le serveur → relancer** →
   vérifier que sessions et versions reviennent intactes dans l'UI.
3. Vérification manuelle des endpoints : liste, chargement, suppression,
   404 sur id inconnu, 400 sur id malformé.

## Hors périmètre

Renommage de sessions, branches de versions, export .zip, design systems par
projet (roadmap n°2), authentification.
