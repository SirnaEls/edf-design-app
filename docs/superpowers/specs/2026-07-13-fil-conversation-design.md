# Fil de conversation + activité de génération en direct — Design

**Date :** 2026-07-13 · **Statut :** validé · **Origine :** demande d'alignement sur l'expérience Claude Design (fil d'échanges + feedback d'activité pendant la génération)

## Objectif

Le panneau gauche devient un **fil de discussion** : on prompte, on itère en continuant la conversation, et la préview se met à jour. Pendant la génération, une **carte d'activité** montre en direct ce que fait le serveur (compteur de caractères reçus, phases). Les sessions migrent dans un tiroir. La préview, les exports et le contrat de `/api/generate` ne changent pas.

## Ce qui ne change pas (contraintes intactes)

- Contrat `POST /api/generate` : mêmes entrées (`prompt`, `sessionId?`, `versionIndex?`) et **même réponse JSON complète**. Un champ optionnel `generationId` s'ajoute au body, rien d'autre.
- Appel portail en `stream: true` + parseur tolérant (contraintes gateway n°1 et 2).
- Préview via Blob URL (contrainte n°3), header, boutons Copier/Télécharger/Ouvrir.
- `store.js`, persistance, routes sessions.
- Dark Linear/Raycast, variables CSS dans `:root`, RGAA (focus visible, contrastes AA, boutons natifs).

## Panneau gauche — le fil

Structure verticale : **header du panneau** (titre de la session courante ou « Nouveau design ») → **fil scrollable** → **composer fixé en bas**.

Le fil affiche la session courante, du plus ancien au plus récent, auto-scrollé vers le bas à chaque ajout :

- **Bulle prompt** (une par version) : le texte du prompt, aligné à droite, fond subtil (`--surface`), coins arrondis.
- **Carte-version** (sous chaque bulle) : `v3 · 12:04`, cliquable. La carte **active** (affichée en préview ET base de la prochaine itération) porte un surlignage net (bordure accent). Cliquer une ancienne carte la rend active — c'est la mécanique `versionIndex` existante, présentée en conversation.
- **Fil vide** (nouveau design) : message d'accueil centré, repris de l'écran idle actuel.

Rechargement de page : le fil se reconstruit depuis la session (les prompts et heures sont déjà dans `versions[]`), carte active = dernière version.

## Carte d'activité (pendant une génération)

À l'envoi : la bulle prompt apparaît immédiatement, suivie d'une carte d'activité :

- Spinner discret + phase + compteur : « Génération en cours… 12 400 caractères · 23 s ». Compteur et durée rafraîchis par polling (500 ms).
- Phases affichées : `attente` (requête partie, aucun chunk reçu) → `génération` (chunks reçus, compteur vivant) → `extraction` → `enregistré`. Les deux dernières sont brèves ; la carte se transforme ensuite en carte-version.
- **Erreur** : la carte d'activité devient une **carte d'erreur dans le fil** — message français renvoyé par le serveur + bouton « Réessayer » (réutilise le dernier prompt). Plus d'écran d'erreur plein panneau. La préview garde la version active précédente.
- Si le polling échoue (réseau, 404), la carte garde le spinner et le temps écoulé local — on perd le compteur, jamais la génération.
- Changement de session pendant une génération (via le tiroir) : le fil affiché devient celui de la nouvelle session, la carte d'activité disparaît avec l'ancien fil, et le garde-fou existant (`requestSessionId`) continue de s'appliquer à l'arrivée du résultat — rafraîchissement des métadonnées uniquement, pas de mutation du fil affiché. Le polling s'arrête quand la carte n'est plus affichée.

## Composer

Textarea auto-extensible (1 à ~6 lignes) fixée en bas du panneau, bouton « Générer », raccourci ⌘/Ctrl+Entrée conservé. Désactivé pendant une génération (le fil raconte l'attente — le hint « 20 à 60 s… » disparaît). Label accessible conservé.

## Tiroir sessions

- Header de l'app : bouton « Sessions » (ouvre le tiroir) + bouton « Nouveau design » (comportement actuel `newDesign()`).
- Tiroir : panneau latéral au-dessus du contenu (overlay), liste des sessions comme aujourd'hui (titre, n versions, date, bouton suppression avec `confirm`), clic → `openSession` + fermeture du tiroir.
- Accessibilité : `role="dialog"` + `aria-modal`, focus piégé dans le tiroir, fermeture par Échap et clic sur l'arrière-plan, focus rendu au bouton « Sessions » à la fermeture.
- Suppression de la session courante → fil vide (comportement actuel conservé).

## Backend — progression en mémoire (seul changement serveur)

- `POST /api/generate` accepte `generationId` optionnel : chaîne `^[a-z0-9-]{8,64}$` générée par le front (`crypto.randomUUID()`). Invalide → ignoré (pas d'erreur : le feedback est optionnel, la génération prime).
- Map mémoire `progress : generationId → { phase, chars, startedAt }` :
  - créée à l'entrée du handler (`phase: "attente"`),
  - `consumeStreamTolerantly` reçoit un callback optionnel `onProgress(chars)` → met à jour `chars` et passe `phase: "génération"` au premier chunk,
  - `phase: "extraction"` après la fin du stream, `phase: "enregistré"` après `saveSession`,
  - entrée **supprimée** dans le `finally` du handler (succès comme erreur), + balai périodique qui purge toute entrée de plus de 10 min (filet si le process du handler meurt avant le finally).
- `GET /api/progress/:id` : `200 { phase, chars, elapsedMs }` ou `404 { error }` (id inconnu ou déjà nettoyé — le front traite le 404 comme « pas de compteur », silencieusement). Lecture seule, aucune donnée sensible (ni prompt ni HTML).

## Finition visuelle

Sur la base dark existante : bordures subtiles (`--border`), transitions 150 ms sur hover/état actif, hiérarchie typographique du fil (prompt en corps normal, méta des cartes en `--text-dim` mono), espacement vertical généreux entre échanges. Focus visible sur bulle/cartes/tiroir/composer. Contrastes AA vérifiés sur les nouveaux éléments.

## Tests

- Les 6 tests API existants restent verts **sans modification** (le contrat ne change pas).
- Nouveaux tests (`test/api.test.js`) :
  1. `GET /api/progress/inconnu` → 404.
  2. Pendant une génération (mock qui streame par rafales de 50 ms) : un poll concurrent renvoie `phase: "génération"` et `chars > 0`.
  3. Après la fin de la génération : le même id renvoie 404 (nettoyage).
  4. `generationId` au format invalide dans le POST → la génération aboutit quand même (200, version créée).
- Vérification navigateur de bout en bout (Chrome) : fil, itération, clic ancienne version, tiroir (souris + clavier/Échap), carte d'erreur (portail coupé), rechargement de page, survie au restart serveur.

## Hors périmètre

Édition/suppression d'un message du fil, branches de conversation, renommage de session, streaming du HTML vers le navigateur (le polling suffit), design systems (feature suivante), responsive mobile.
