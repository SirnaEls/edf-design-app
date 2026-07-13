# Fil de conversation + activité en direct — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le panneau gauche devient un fil de discussion (bulles prompt + cartes-versions + composer en bas), avec une carte d'activité au compteur vivant pendant la génération et les sessions dans un tiroir.

**Architecture:** Le contrat `POST /api/generate` ne change pas (réponse JSON complète) ; un `generationId` optionnel s'ajoute au body et alimente une Map mémoire exposée en lecture par `GET /api/progress/:id`, que le front interroge à 500 ms pendant la génération. Le front (vanilla, un seul fichier `public/index.html`) est restructuré : fil scrollable reconstruit depuis `session.versions[]`, composer fixe, tiroir sessions en overlay.

**Tech Stack:** Node ≥18, Express, dotenv, node:test. Front vanilla (aucun framework). Spec : `docs/superpowers/specs/2026-07-13-fil-conversation-design.md`.

## Global Constraints

- Appel portail en `stream: true` + parseur `consumeStreamTolerantly` tolérant : NE PAS MODIFIER la logique d'accumulation (contraintes gateway n°1 et 2 de PROJET.md).
- Préview via **Blob URL**, jamais `srcdoc`+sandbox (contrainte n°3).
- Contrat de réponse de `POST /api/generate` inchangé : `{ sessionId, title, versionIndex, version }` | 400/404/502/504 `{ error }`.
- Pas de dépendance ajoutée. Front vanilla. Français partout (UI, erreurs, commentaires). RGAA : focus visible, labels, contrastes AA, boutons natifs.
- Aucune mention « Claude » nulle part (fichiers ET messages de commit — pas de trailer Co-Authored-By).
- `GET /api/progress/:id` n'expose ni prompt ni HTML — uniquement `{ phase, chars, elapsedMs }`.

---

### Task 1 : Backend — progression des générations en mémoire

**Files:**
- Modify: `server.js` (après `extractHtml` ~l.106 ; handler `/api/generate` l.108-… ; routes sessions ~l.225)
- Test: `test/api.test.js` (ajout de 3 tests en fin de fichier)

**Interfaces:**
- Consumes: `consumeStreamTolerantly(response)` existant (l.60-96), `progressMap` n'existe pas encore.
- Produces (utilisé par la Task 3, le front) :
  - `POST /api/generate` accepte en plus `generationId?: string` (`^[a-z0-9-]{8,64}$` ; invalide → ignoré silencieusement, la génération aboutit quand même).
  - `GET /api/progress/:id` → `200 { phase: "attente"|"génération"|"extraction"|"enregistré", chars: number, elapsedMs: number }` | `404 { error }` (inconnu OU terminé — l'entrée est supprimée dans le `finally` du handler).
  - `consumeStreamTolerantly(response, onProgress?)` : appelle `onProgress(text.length)` à chaque itération de chunk.

- [ ] **Step 1 : Écrire les tests qui échouent** — ajouter à la fin de `test/api.test.js` (après le test « DELETE supprime la session ») :

```js
test("progress : 404 sur id inconnu", async () => {
  const res = await fetch(`${base}/api/progress/id-inconnu-123`);
  assert.equal(res.status, 404);
});

test("progress : compteur vivant pendant la génération, puis 404 une fois finie", async () => {
  const gid = `test-progress-${Date.now()}`;
  const pending = post("/api/generate", { prompt: "Page de profil", generationId: gid });
  // Le mock streame par rafales de 50 ms : on sonde vite pour attraper la phase « génération »
  let vu = null;
  for (let i = 0; i < 200 && !vu; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const pr = await fetch(`${base}/api/progress/${gid}`);
    if (pr.ok) {
      const j = await pr.json();
      if (j.phase === "génération" && j.chars > 0) vu = j;
    }
  }
  assert.ok(vu, "le poll doit voir phase=génération avec chars > 0 pendant le stream");
  assert.ok(vu.elapsedMs >= 0);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${base}/api/progress/${gid}`)).status, 404, "entrée nettoyée après la fin");
});

test("generationId au format invalide : ignoré, la génération aboutit", async () => {
  const res = await post("/api/generate", { prompt: "Page contact", generationId: "PAS BON !!" });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).sessionId);
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `npm test`
Attendu : FAIL — les 3 nouveaux tests échouent (`/api/progress/...` renvoie du HTML 404 Express, pas du JSON ; pas de phase). Les 14 tests existants restent verts.

- [ ] **Step 3 : Implémenter dans `server.js`**

3a. Ajouter `onProgress` à `consumeStreamTolerantly` — signature et fin de boucle de chunk uniquement, le corps d'accumulation NE CHANGE PAS :

```js
async function consumeStreamTolerantly(response, onProgress) {
```

et juste avant la fin du bloc `for await (const chunk of response.body) { … }` (après la boucle `for (const line of lines)`) :

```js
    if (onProgress) onProgress(text.length);
```

3b. Après `extractHtml` (~l.106), ajouter :

```js
/**
 * Progression des générations en cours, pour le compteur du fil côté front.
 * En mémoire uniquement (outil mono-utilisateur) ; n'expose ni prompt ni HTML.
 */
const progressMap = new Map(); // generationId → { phase, chars, startedAt }
const PROGRESS_TTL_MS = 10 * 60 * 1000;
const isValidGenerationId = (id) => typeof id === "string" && /^[a-z0-9-]{8,64}$/.test(id);
// Balai : filet de sécurité si un handler meurt avant son finally. unref()
// pour ne pas retenir le process (les tests importent { app } puis sortent).
setInterval(() => {
  const seuil = Date.now() - PROGRESS_TTL_MS;
  for (const [id, p] of progressMap) if (p.startedAt < seuil) progressMap.delete(id);
}, 60 * 1000).unref();
```

3c. Dans le handler `POST /api/generate` :

```js
  const { prompt, sessionId, versionIndex, generationId } = req.body || {};
```

Après la résolution de `session` (juste avant le bloc `const count = session.versions.length;`) :

```js
  // Suivi de progression : optionnel, jamais bloquant (id invalide → ignoré)
  const trackId = isValidGenerationId(generationId) ? generationId : null;
  if (trackId) progressMap.set(trackId, { phase: "attente", chars: 0, startedAt: Date.now() });
```

Remplacer l'appel `const text = await consumeStreamTolerantly(upstream);` par :

```js
    const text = await consumeStreamTolerantly(upstream, trackId
      ? (chars) => {
          const p = progressMap.get(trackId);
          if (p) { p.phase = "génération"; p.chars = chars; }
        }
      : undefined);
    if (trackId) {
      const p = progressMap.get(trackId);
      if (p) p.phase = "extraction";
    }
```

Après `await store.saveSession(session);` :

```js
    if (trackId) {
      const p = progressMap.get(trackId);
      if (p) p.phase = "enregistré";
    }
```

Dans le `finally` existant du handler :

```js
  } finally {
    clearTimeout(timer);
    if (trackId) progressMap.delete(trackId);
  }
```

3d. Après la route `DELETE /api/sessions/:id`, ajouter :

```js
app.get("/api/progress/:id", (req, res) => {
  const p = progressMap.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Génération inconnue ou terminée." });
  res.json({ phase: p.phase, chars: p.chars, elapsedMs: Date.now() - p.startedAt });
});
```

- [ ] **Step 4 : Vérifier le succès**

Run : `npm test`
Attendu : PASS — 17 tests (7 store + 10 api), 0 échec, sortie propre, le process se termine (vérifier l'absence de blocage : le `unref()` y veille).

- [ ] **Step 5 : Commit**

```bash
git add server.js test/api.test.js
git commit -m "feat: progression des générations en mémoire (GET /api/progress/:id)"
```

---

### Task 2 : Front — fil de conversation, composer, tiroir sessions

**Files:**
- Modify: `public/index.html` (CSS l.66-167 et l.193-224 ; HTML `<header>` l.229-236 et `<aside>` l.239-261 ; JS : `renderSessions`, `renderVersions`→`renderThread`, `openSession`, `newDesign`, `selectVersion`, écouteurs, `init`)

**Interfaces:**
- Consumes: routes existantes (`/api/sessions*`, `/api/generate` — contrat inchangé), mécanique `versionIndex`/`activeIndex` existante, garde `requestSessionId` existante dans `generate()`.
- Produces (utilisé par la Task 3) : fonction `renderThread()` qui affiche `versions[]` + un éventuel état `pending` (objet module-scope, `null` dans cette tâche) ; conteneur `#thread` ; composer `#prompt`/`#generateBtn` ; tiroir `#drawer` avec `openDrawer()`/`closeDrawer()`.

Dans cette tâche, la génération garde l'écran de chargement actuel de la préview (`loadingState`) — la carte d'activité arrive en Task 3.

- [ ] **Step 1 : CSS** — remplacer les blocs `/* ---- Panneau gauche ---- */` et `/* ---- Sessions & Versions ---- */` (l.66-167) par :

```css
  /* ---- Panneau gauche : fil de conversation ---- */
  aside {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .thread-head {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .thread-head h2 {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bubble {
    align-self: flex-end;
    max-width: 88%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    border-bottom-right-radius: 4px;
    padding: 10px 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .card {
    align-self: stretch;
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    color: var(--text);
    font-weight: 400;
    transition: border-color 150ms, background 150ms;
  }
  .card:hover { border-color: var(--text-dim); }
  .card.active { border-color: var(--accent); background: var(--panel-2); }
  .card .v-num { font-family: var(--mono); font-size: 11px; color: var(--accent); }
  .card .v-meta { font-family: var(--mono); font-size: 11px; color: var(--text-dim); margin-left: 8px; }
  .empty { color: var(--text-dim); font-size: 13px; line-height: 1.6; margin: auto; text-align: center; padding: 24px; }

  /* ---- Composer ---- */
  .composer {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    padding: 12px 16px;
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .composer textarea {
    flex: 1;
    min-height: 40px;
    max-height: 132px;
    resize: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    padding: 10px 12px;
    font: inherit;
    line-height: 1.5;
  }
  .composer textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .composer .btn-primary { width: auto; margin: 0; padding: 10px 14px; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ---- Tiroir sessions ---- */
  .drawer-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9;
  }
  .drawer {
    position: fixed; top: 0; left: 0; bottom: 0;
    width: 320px;
    background: var(--panel);
    border-right: 1px solid var(--border);
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: 16px;
    overflow-y: auto;
  }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .drawer-head h2 { font-size: 12px; color: var(--text-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .drawer.hidden, .drawer-backdrop.hidden { display: none; }
  .session-row { position: relative; }
  .session-row .card { width: 100%; padding-right: 36px; margin-bottom: 8px; display: block; }
  .s-title { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-meta { display: block; font-family: var(--mono); font-size: 11px; color: var(--text-dim); margin-top: 3px; }
  .session-delete {
    position: absolute; top: 8px; right: 8px;
    background: transparent; border: 1px solid transparent;
    color: var(--text-dim); padding: 2px 8px; font-size: 14px; line-height: 1; border-radius: 6px;
  }
  .session-delete:hover, .session-delete:focus-visible { color: var(--danger); border-color: var(--danger); }
```

Conserver tels quels les blocs `button`, `.btn-primary`, `.btn-ghost`, `.btn-small` (l.89-109 et l.125) — seul `.hint` (l.111) est supprimé. Conserver `/* ---- Préview ---- */` et `/* ---- États ---- */` intacts dans cette tâche.

- [ ] **Step 2 : HTML** — remplacer `<header>` (l.229-236) et `<aside>` (l.239-261) par :

```html
<header>
  <div class="logo">EDF <span>Design</span></div>
  <div class="badge" id="modelBadge">portail IAG · stream tolérant</div>
  <div class="header-actions">
    <button class="btn-ghost" id="sessionsBtn" aria-haspopup="dialog">Sessions</button>
    <button class="btn-ghost" id="newSessionBtn">Nouveau design</button>
    <button class="btn-ghost" id="copyBtn" disabled>Copier le code</button>
    <button class="btn-ghost" id="downloadBtn" disabled>Télécharger .html</button>
  </div>
</header>

<div class="drawer-backdrop hidden" id="drawerBackdrop"></div>
<div class="drawer hidden" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
  <div class="drawer-head">
    <h2 id="drawerTitle">Sessions</h2>
    <button class="btn-ghost btn-small" id="drawerCloseBtn" aria-label="Fermer les sessions">✕</button>
  </div>
  <div id="sessionList" role="list" aria-labelledby="drawerTitle">
    <p class="empty">Aucune session enregistrée.</p>
  </div>
</div>

<main>
  <aside>
    <div class="thread-head">
      <h2 id="threadTitle">Nouveau design</h2>
    </div>
    <div class="thread" id="thread"></div>
    <div class="composer">
      <label for="prompt" class="sr-only">Décris l'interface ou la modification</label>
      <textarea id="prompt" rows="1" placeholder="Décris l'interface ou la modification…"></textarea>
      <button class="btn-primary" id="generateBtn">Générer</button>
    </div>
  </aside>
```

La `<section class="preview">` ne change pas dans cette tâche.

- [ ] **Step 3 : JS** — modifications du `<script>` :

3a. Remplacer `renderVersions()` (l.402-419) par `renderThread()` — et remplacer **tous** les appels `renderVersions()` (dans `openSession`, `newDesign`, `selectVersion`) par `renderThread()` :

```js
  /* ---- Fil de conversation ---- */

  // pending : état de la génération en cours affiché dans le fil (Task 3). null = aucune.
  let pending = null;

  function renderThread() {
    const thread = $("thread");
    thread.innerHTML = "";
    if (!versions.length && !pending) {
      thread.innerHTML = '<p class="empty">Décris une interface ci-dessous et lance la génération.<br />Chaque échange devient une version, cliquable pour y revenir.</p>';
      return;
    }
    versions.forEach((v, i) => {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = v.prompt;
      thread.appendChild(bubble);

      const card = document.createElement("button");
      card.className = "card" + (i === activeIndex ? " active" : "");
      card.innerHTML = '<span class="v-num"></span><span class="v-meta"></span>';
      card.querySelector(".v-num").textContent = `v${i + 1}`;
      card.querySelector(".v-meta").textContent = fmtDate(v.createdAt);
      card.setAttribute("aria-label", `Afficher la version ${i + 1}`);
      card.addEventListener("click", () => selectVersion(i));
      thread.appendChild(card);
    });
    renderPending(thread); // no-op tant que pending === null (implémenté en Task 3)
    thread.scrollTop = thread.scrollHeight;
  }

  function renderPending(thread) {
    // Task 3 : bulle du prompt en vol + carte d'activité / carte d'erreur.
    void thread;
  }
```

3b. Titre du fil — dans `openSession`, après `versions = s.versions;`, ajouter `$("threadTitle").textContent = s.title;`. Dans `newDesign`, ajouter `$("threadTitle").textContent = "Nouveau design";`. Dans `generate()`, quand une session est créée (`isNew`), ajouter `$("threadTitle").textContent = data.title;` juste après la mise à jour de `sessions`.

3c. Tiroir — remplacer l'écouteur `newSessionBtn` existant et ajouter à côté des autres écouteurs :

```js
  /* ---- Tiroir sessions ---- */

  let drawerReturnFocus = null;

  function openDrawer() {
    drawerReturnFocus = document.activeElement;
    $("drawer").classList.remove("hidden");
    $("drawerBackdrop").classList.remove("hidden");
    $("drawerCloseBtn").focus();
  }

  function closeDrawer() {
    $("drawer").classList.add("hidden");
    $("drawerBackdrop").classList.add("hidden");
    if (drawerReturnFocus) drawerReturnFocus.focus();
  }

  $("sessionsBtn").addEventListener("click", openDrawer);
  $("drawerCloseBtn").addEventListener("click", closeDrawer);
  $("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("drawer").classList.contains("hidden")) closeDrawer();
  });
  // Piège à focus minimal : Tab reste dans le tiroir tant qu'il est ouvert
  $("drawer").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = $("drawer").querySelectorAll("button");
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $("newSessionBtn").addEventListener("click", newDesign);
```

Dans `renderSessions()`, le clic sur une session ferme le tiroir : remplacer `open.addEventListener("click", () => openSession(s.id));` par `open.addEventListener("click", () => { openSession(s.id); closeDrawer(); });`. Remplacer aussi `open.className = "version-item"…` par `open.className = "card"…` (la classe `.version-item` n'existe plus).

3d. Composer auto-extensible + suppression du hint — ajouter près des écouteurs :

```js
  $("prompt").addEventListener("input", () => {
    const t = $("prompt");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 132) + "px";
  });
```

3e. `newDesign()` : la ligne `$("prompt").focus();` reste ; `renderSessions()` reste (le tiroir peut être ouvert).

- [ ] **Step 4 : Vérifier**

Run : `npm test` → attendu : les tests serveur restent verts (le front n'est pas testé automatiquement).
Puis lancement réel contre le mock :

```bash
node test/mock-gateway.js &
DATA_DIR=/tmp/edf-fil IAG_BASE_URL=http://localhost:9999/v1 IAG_API_KEY=x IAG_MODEL=x node server.js &
sleep 1
curl -s -X POST localhost:3000/api/generate -H "Content-Type: application/json" -d '{"prompt":"Page test"}' | head -c 200
kill %1 %2
```

Attendu : JSON `{ sessionId, … }`. Vérifier aussi que `public/index.html` ne contient plus `version-item`, `prompt-zone`, `hint`, `sessionsTitle`, `versionsTitle` (`grep -c` = 0 pour chacun).

- [ ] **Step 5 : Commit**

```bash
git add public/index.html
git commit -m "feat: fil de conversation, composer en bas et tiroir sessions"
```

---

### Task 3 : Front — carte d'activité vivante + erreurs dans le fil

**Files:**
- Modify: `public/index.html` (CSS `/* ---- États ---- */` ; HTML section préview ; JS `generate()`, `renderPending()`, suppression `startTimer`/`stopTimer`/`retryBtn`)

**Interfaces:**
- Consumes: `GET /api/progress/:id` (Task 1), `renderThread()`/`renderPending(thread)`/variable `pending` (Task 2), garde `requestSessionId` existante.
- Produces: état final de la feature. `pending = { prompt, gid, startedAt, phase, chars, error }`.

- [ ] **Step 1 : HTML préview** — supprimer les blocs `#loadingState` et `#errorState` (le spinner et l'erreur vivent désormais dans le fil). La section devient :

```html
  <section class="preview">
    <div class="preview-bar">
      <span class="title" id="previewTitle">preview</span>
      <div class="actions">
        <button class="btn-ghost" id="openTabBtn" disabled>Ouvrir dans un onglet</button>
      </div>
    </div>

    <div class="state" id="idleState">
      <p>Décris une interface à gauche et lance la génération.<br />Le résultat s'affichera ici, itérable version par version.</p>
    </div>

    <iframe id="frame" class="hidden" title="Prévisualisation de l'interface générée"></iframe>
  </section>
```

Et dans `setState()` : `["idleState"].forEach(…)` (seuls `idleState` et `frame` subsistent).

- [ ] **Step 2 : CSS** — dans `/* ---- États ---- */`, supprimer `.timer` et `.error-box` (déplacés dans le fil), garder `.state`, `.spinner`, `@keyframes spin` et la règle `prefers-reduced-motion`. Ajouter :

```css
  .activity {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
  }
  .activity .spinner { width: 16px; height: 16px; border-width: 2px; flex-shrink: 0; }
  .activity .a-label { font-size: 13px; }
  .activity .a-meta { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); margin-left: auto; white-space: nowrap; }
  .card-error {
    align-self: stretch;
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    padding: 10px 12px;
    color: var(--danger);
    font-size: 13px;
    line-height: 1.5;
  }
  .card-error .btn-ghost { margin-top: 8px; color: var(--text); }
```

- [ ] **Step 3 : JS** — remplacer `renderPending`, `generate` et les restes du mode timer :

3a. Supprimer `startTimer`, `stopTimer`, la variable `timerInterval`, et l'écouteur `$("retryBtn")` (le bouton n'existe plus dans la préview).

3b. Remplacer `renderPending` (stub de la Task 2) par :

```js
  const PHASE_LABELS = {
    attente: "Envoi au portail IAG…",
    génération: "Génération en cours…",
    extraction: "Extraction du HTML…",
    enregistré: "Version enregistrée",
  };

  function renderPending(thread) {
    if (!pending) return;
    if (pending.prompt) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = pending.prompt;
      thread.appendChild(bubble);
    }

    if (pending.error) {
      const card = document.createElement("div");
      card.className = "card-error";
      card.setAttribute("role", "alert");
      const msg = document.createElement("div");
      msg.textContent = pending.error;
      const retry = document.createElement("button");
      retry.className = "btn-ghost";
      retry.textContent = "Réessayer";
      retry.addEventListener("click", () => {
        const r = pending.retry;
        pending = null;
        r();
      });
      card.append(msg, retry);
      thread.appendChild(card);
      return;
    }

    const card = document.createElement("div");
    card.className = "activity";
    card.setAttribute("role", "status");
    const secs = Math.round((Date.now() - pending.startedAt) / 1000);
    const meta = pending.chars > 0 ? `${pending.chars.toLocaleString("fr-FR")} car. · ${secs} s` : `${secs} s`;
    card.innerHTML = '<div class="spinner" aria-hidden="true"></div><span class="a-label"></span><span class="a-meta"></span>';
    card.querySelector(".a-label").textContent = PHASE_LABELS[pending.phase] || PHASE_LABELS.attente;
    card.querySelector(".a-meta").textContent = meta;
    thread.appendChild(card);
  }
```

3c. Remplacer `generate()` en entier par :

```js
  async function generate() {
    const prompt = $("prompt").value.trim();
    if (!prompt || pending) return;
    const requestSessionId = currentSessionId;
    const gid = crypto.randomUUID();
    pending = {
      prompt, gid,
      startedAt: Date.now(), phase: "attente", chars: 0, error: null,
      retry: () => { $("prompt").value = prompt; generate(); },
    };
    $("generateBtn").disabled = true;
    $("prompt").disabled = true;
    $("prompt").value = "";
    $("prompt").style.height = "auto";
    renderThread();

    // Polling : rafraîchit la carte d'activité tant que CETTE génération est
    // affichée. Un échec de poll ne coupe jamais la génération elle-même.
    const poll = setInterval(async () => {
      if (!pending || pending.gid !== gid || currentSessionId !== requestSessionId) return;
      try {
        const r = await fetch(`/api/progress/${gid}`);
        if (r.ok) {
          const j = await r.json();
          pending.phase = j.phase;
          pending.chars = j.chars;
        }
      } catch { /* réseau : on garde le temps écoulé local */ }
      if (pending && pending.gid === gid && currentSessionId === requestSessionId && !pending.error) renderThread();
    }, 500);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          sessionId: currentSessionId,
          versionIndex: activeIndex >= 0 ? activeIndex : undefined,
          generationId: gid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur inconnue");

      if (currentSessionId !== requestSessionId) {
        // L'utilisateur a changé de session pendant la génération : le serveur
        // a persisté la version, on rafraîchit les métadonnées sans toucher au fil.
        pending = null;
        await loadSessionList();
        return;
      }

      pending = null;
      const isNew = !currentSessionId;
      currentSessionId = data.sessionId;
      versions.push(data.version);
      if (isNew) {
        $("threadTitle").textContent = data.title;
        sessions.unshift({
          id: data.sessionId,
          title: data.title,
          createdAt: data.version.createdAt,
          updatedAt: data.version.createdAt,
          versionCount: versions.length,
        });
      } else {
        const meta = sessions.find((s) => s.id === currentSessionId);
        if (meta) { meta.updatedAt = data.version.createdAt; meta.versionCount = versions.length; }
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      selectVersion(versions.length - 1);
      renderSessions();
    } catch (err) {
      if (currentSessionId === requestSessionId && pending && pending.gid === gid) {
        pending.error = err.message;
        renderThread();
      } else {
        pending = null;
      }
    } finally {
      clearInterval(poll);
      $("generateBtn").disabled = false;
      $("prompt").disabled = false;
      if (currentSessionId === requestSessionId) $("prompt").focus();
    }
  }
```

Note : `lastPrompt` ne sert plus (le Réessayer lit `pending.retry`) — supprimer la variable et ses affectations. Dans `openSession` et `newDesign`, ajouter `pending = null;` en tête (changer de fil abandonne l'affichage de la génération en cours, la garde `requestSessionId` protège le résultat).

3d. Le `catch` de `openSession` référence `errorMsg`/`errorState` qui n'existent plus : le remplacer par une carte d'erreur dans le fil, avec un Réessayer qui recharge la session :

```js
    } catch (err) {
      pending = {
        prompt: "", gid: null,
        startedAt: Date.now(), phase: null, chars: 0,
        error: `Impossible de charger la session : ${err.message}`,
        retry: () => openSession(id),
      };
      renderThread();
    }
```

- [ ] **Step 4 : Vérifier**

Run : `npm test` → 17 tests verts.
Lancement réel contre le mock (mêmes commandes que Task 2 Step 4) puis vérifications :
- `grep -c "loadingState\|errorState\|errorMsg\|startTimer\|retryBtn\|lastPrompt" public/index.html` → 0.
- `curl` de génération OK, et pendant une génération lancée en parallèle, `curl localhost:3000/api/progress/<gid>` renvoie une phase.

- [ ] **Step 5 : Commit**

```bash
git add public/index.html
git commit -m "feat: carte d'activité en direct et erreurs dans le fil"
```

---

## Vérification finale (contrôleur)

Après les 3 tâches : passe navigateur complète en Chrome contre le mock — fil (bulles + cartes), génération avec compteur vivant, itération, clic ancienne version, tiroir (souris, Tab, Échap), carte d'erreur (serveur mock coupé), rechargement de page, survie au restart. Puis revue finale de branche et merge.
