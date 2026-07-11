# Persistance des sessions et versions — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** Persister les sessions de design (suites de versions) dans des fichiers JSON sur disque, avec le serveur comme source de vérité, pour survivre aux restarts du serveur et aux refreshs navigateur.

**Architecture :** Un module `store.js` (fs/promises, écriture atomique tmp+rename, un fichier JSON par session dans `data/sessions/`). `server.js` gagne trois endpoints CRUD sessions et son `/api/generate` reconstruit le contexte depuis le disque au lieu de recevoir le HTML du front. Le front devient un cache d'affichage : section Sessions dans le panneau gauche, rechargement auto de la dernière session.

**Tech stack :** Node.js ≥ 18 (fetch natif, `node:test`), Express, vanilla JS front. **Aucune dépendance ajoutée.**

**Spec :** `docs/superpowers/specs/2026-07-12-persistance-sessions-design.md`

## Global Constraints

- **NE PAS CASSER** (PROJET.md) : appel portail en `stream: true` ; parseur `consumeStreamTolerantly` tolérant (jamais de SDK strict) ; préview via Blob URL (jamais `srcdoc` + sandbox).
- Pas de dépendance ajoutée : express + dotenv suffisent, tests via `node:test` intégré.
- Français partout : UI, messages d'erreur, commentaires.
- RGAA : focus visible, labels/aria, contrastes AA.
- Ids de session validés par `^s_[0-9]+_[0-9a-f]+$` à chaque lecture (anti path traversal).
- Échec de génération → rien n'est écrit sur disque.
- **Pas de dépôt git dans ce dossier** : les étapes « commit » habituelles sont omises. Si tu veux versionner, `git init` d'abord (le `.gitignore` existe déjà).

---

### Task 1 : Module de stockage `store.js`

**Files:**
- Create: `store.js`
- Create: `test/store.test.js`
- Modify: `package.json` (script `test`)
- Modify: `.gitignore` (ajouter `data/`)

**Interfaces:**
- Consumes: rien (module feuille, `fs/promises` + `path` + `crypto` intégrés).
- Produces (utilisé par Task 3) :
  - `isValidId(id: any) → boolean`
  - `newSession(firstPrompt: string) → { id, title, createdAt, updatedAt, versions: [] }` (pur, aucune écriture disque)
  - `saveSession(session) → Promise<void>` (atomique : tmp puis rename, crée `data/sessions/` si absent)
  - `loadSession(id) → Promise<session | null>` (null si id invalide, absent ou JSON corrompu)
  - `listSessions() → Promise<[{ id, title, createdAt, updatedAt, versionCount }]>` (tri `updatedAt` décroissant, fichiers corrompus ignorés avec `console.error`)
  - `deleteSession(id) → Promise<boolean>`
  - `DATA_DIR: string` (surchargeable par la variable d'env `DATA_DIR`, pour les tests)

- [ ] **Step 1 : Écrire les tests qui échouent** — `test/store.test.js` :

```js
/** Tests du store de sessions — node:test, aucun framework externe. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// Répertoire temporaire AVANT le require : store.js lit DATA_DIR au chargement
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "edf-store-"));
const store = require("../store");

test("newSession : id valide, titre tronqué à 80 caractères, aucune version", () => {
  const s = store.newSession("x".repeat(200));
  assert.ok(store.isValidId(s.id));
  assert.equal(s.title.length, 80);
  assert.ok(s.title.endsWith("…"));
  assert.deepEqual(s.versions, []);
  assert.equal(s.createdAt, s.updatedAt);
});

test("newSession : titre court gardé tel quel", () => {
  assert.equal(store.newSession("Dashboard API").title, "Dashboard API");
});

test("isValidId refuse les ids dangereux ou malformés", () => {
  for (const bad of ["../etc/passwd", "s_12_ZZ", "s_12_ab/../x", "", null, 42, "S_12_ab"]) {
    assert.equal(store.isValidId(bad), false, `devrait refuser ${JSON.stringify(bad)}`);
  }
  assert.equal(store.isValidId("s_1720735200000_ab3f"), true);
});

test("save puis load : la session revient intacte", async () => {
  const s = store.newSession("Dashboard de test");
  s.versions.push({ prompt: "Dashboard de test", html: "<!DOCTYPE html><html></html>", createdAt: s.createdAt });
  await store.saveSession(s);
  assert.deepEqual(await store.loadSession(s.id), s);
});

test("loadSession : null si id invalide ou fichier absent", async () => {
  assert.equal(await store.loadSession("../hack"), null);
  assert.equal(await store.loadSession("s_1_dead00"), null);
});

test("listSessions : tri updatedAt décroissant, fichier corrompu ignoré", async () => {
  const vieille = store.newSession("vieille session");
  vieille.updatedAt = "2026-01-01T00:00:00.000Z";
  const recente = store.newSession("session récente");
  recente.updatedAt = "2026-06-01T00:00:00.000Z";
  await store.saveSession(vieille);
  await store.saveSession(recente);
  await fs.writeFile(path.join(store.DATA_DIR, "s_1_c0ffee.json"), "{{{ pas du JSON", "utf8");

  const list = await store.listSessions();
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes(vieille.id) && ids.includes(recente.id));
  assert.ok(ids.indexOf(recente.id) < ids.indexOf(vieille.id), "la plus récente d'abord");
  assert.ok(!ids.includes("s_1_c0ffee"), "le fichier corrompu est ignoré");
  const meta = list.find((x) => x.id === vieille.id);
  assert.deepEqual(Object.keys(meta).sort(), ["createdAt", "id", "title", "updatedAt", "versionCount"]);
});

test("deleteSession : true puis la session disparaît ; false si inconnue", async () => {
  const s = store.newSession("à supprimer");
  await store.saveSession(s);
  assert.equal(await store.deleteSession(s.id), true);
  assert.equal(await store.loadSession(s.id), null);
  assert.equal(await store.deleteSession(s.id), false);
  assert.equal(await store.deleteSession("../hack"), false);
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `node --test test/store.test.js`
Attendu : FAIL — `Cannot find module '../store'`

- [ ] **Step 3 : Implémenter `store.js`**

```js
/**
 * EDF Design — persistance des sessions sur disque.
 * Un fichier JSON par session dans data/sessions/ : une session corrompue
 * ne détruit pas les autres. Écriture atomique (tmp + rename) : survit à
 * un arrêt du serveur en pleine écriture.
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data", "sessions");
// Format strict : interdit tout path traversal via un id forgé
const ID_RE = /^s_[0-9]+_[0-9a-f]+$/;
const TITLE_MAX = 80;

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function newSession(firstPrompt) {
  const now = new Date().toISOString();
  return {
    id: `s_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    title:
      firstPrompt.length > TITLE_MAX
        ? firstPrompt.slice(0, TITLE_MAX - 1) + "…"
        : firstPrompt,
    createdAt: now,
    updatedAt: now,
    versions: [], // { prompt, html, createdAt }
  };
}

function fileFor(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

async function saveSession(session) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const target = fileFor(session.id);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session), "utf8");
  await fs.rename(tmp, target);
}

async function loadSession(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[store] session ${id} illisible :`, err.message);
    }
    return null;
  }
}

async function listSessions() {
  let files;
  try {
    files = await fs.readdir(DATA_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return []; // pas encore de données : liste vide
    throw err;
  }
  const sessions = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const s = await loadSession(f.slice(0, -".json".length));
    if (!s) continue; // corrompu ou nom invalide : déjà loggé, on continue
    sessions.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      versionCount: s.versions.length,
    });
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function deleteSession(id) {
  if (!isValidId(id)) return false;
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

module.exports = { isValidId, newSession, saveSession, loadSession, listSessions, deleteSession, DATA_DIR };
```

- [ ] **Step 4 : Vérifier le succès**

Run : `node --test test/store.test.js`
Attendu : PASS — 7 tests, 0 échec

- [ ] **Step 5 : Brancher le script de test et ignorer `data/`**

Dans `package.json`, ajouter dans `"scripts"` : `"test": "node --test"`.
Dans `.gitignore`, ajouter la ligne : `data/`

Run : `npm test`
Attendu : PASS (mêmes 7 tests, découverts via `test/`)

---

### Task 2 : Mock de la gateway « sale » `test/mock-gateway.js`

Reproduit les défauts réels du portail IAG documentés dans le PROJET.md : ids de chunks qui changent à chaque chunk, rafales bufferisées, lignes de bruit SSE, chunk usage-only final. Sert aux tests d'intégration (Task 3) et se lance à la main pour la vérification navigateur (Task 4).

**Files:**
- Create: `test/mock-gateway.js`

**Interfaces:**
- Consumes: rien (`http` + `crypto` intégrés).
- Produces (utilisé par Task 3 et Task 4) :
  - `startMockGateway(port = 0) → Promise<{ server: http.Server, port: number }>` — répond à `POST */chat/completions` en SSE sale
  - `PAGE: string` — le HTML complet que le stream reconstitue (sert d'attendu dans les tests)
  - Lançable directement : `node test/mock-gateway.js` → écoute sur :9999 (procédure de test du PROJET.md)

- [ ] **Step 1 : Implémenter le mock**

```js
/**
 * Mock du portail IAG « sale » : reproduit les défauts réels de la gateway
 * (ids de chunks changeants, rafales bufferisées, lignes de bruit SSE,
 * chunk usage-only). Utilisé par test/api.test.js et rejouable à la main :
 *   node test/mock-gateway.js   → http://localhost:9999/v1
 */
const http = require("http");
const crypto = require("crypto");

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Maquette générée</title></head>
<body><main><h1>Maquette générée par le mock</h1><p>Contenu de démonstration.</p></main></body>
</html>`;

// Un chunk SSE avec un id DIFFÉRENT à chaque appel — le vice principal de la gateway
function sseChunk(content) {
  const id = "chatcmpl-" + crypto.randomBytes(6).toString("hex");
  return `data: ${JSON.stringify({ id, choices: [{ delta: { content } }] })}\n\n`;
}

function startMockGateway(port = 0) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    req.resume(); // consomme le corps sans le lire
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    const pieces = PAGE.match(/[\s\S]{1,40}/g);
    let i = 0;
    res.write(": bruit-keepalive de la gateway\n\n"); // ligne de bruit SSE
    const timer = setInterval(() => {
      // Rafale bufferisée : 3 chunks d'un coup, chacun avec un id différent
      res.write(pieces.slice(i, i + 3).map(sseChunk).join(""));
      i += 3;
      if (i >= pieces.length) {
        clearInterval(timer);
        // Chunk usage-only (sans delta) puis [DONE]
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-final", usage: { total_tokens: 42 }, choices: [] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 50);
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startMockGateway, PAGE };

if (require.main === module) {
  startMockGateway(9999).then(({ port }) => {
    console.log(`Mock gateway sale → IAG_BASE_URL=http://localhost:${port}/v1`);
  });
}
```

- [ ] **Step 2 : Vérifier à la main**

Run : `node test/mock-gateway.js &` puis
`curl -s -X POST http://localhost:9999/v1/chat/completions | head -5` puis `kill %1`
Attendu : des lignes `data: {"id":"chatcmpl-…","choices":[{"delta":{"content":"…"}}]}` avec des ids **différents** à chaque ligne, précédées de la ligne de bruit `: bruit-keepalive…`.

(La validation automatique complète — le HTML ressort intact du parseur tolérant — est le rôle de Task 3.)

---

### Task 3 : Endpoints serveur + `/api/generate` persistant

**Files:**
- Modify: `server.js` (require en tête ; handler `/api/generate` lignes ~90-165 ; nouveaux endpoints ; export + guard `listen` lignes ~167-171)
- Create: `test/api.test.js`

**Interfaces:**
- Consumes: tout `store.js` (Task 1), `startMockGateway`/`PAGE` (Task 2).
- Produces (utilisé par Task 4, le front) :
  - `POST /api/generate` body `{ prompt: string, sessionId?: string, versionIndex?: number }` → 200 `{ sessionId, title, versionIndex, version: { prompt, html, createdAt } }` | 400 `{ error }` (prompt manquant ou sessionId malformé) | 404 `{ error }` (session inconnue) | 502/504 inchangés
  - `GET /api/sessions` → 200 `[{ id, title, createdAt, updatedAt, versionCount }]`
  - `GET /api/sessions/:id` → 200 session complète (avec les HTML) | 400 | 404
  - `DELETE /api/sessions/:id` → 200 `{ ok: true }` | 400 | 404
  - `server.js` exporte `{ app }` ; `app.listen` ne s'exécute que si `require.main === module`

- [ ] **Step 1 : Écrire les tests d'intégration qui échouent** — `test/api.test.js` :

```js
/**
 * Tests d'intégration : serveur réel + mock gateway sale (Task 2).
 * Valide le contrat API ET que le parseur tolérant reconstitue le HTML
 * intact malgré les ids changeants / rafales / bruit SSE.
 */
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("fs");
const os = require("os");
const path = require("path");
const { startMockGateway, PAGE } = require("./mock-gateway");

// Env AVANT le require de server.js (config lue au chargement).
// dotenv n'écrase pas les variables déjà définies.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "edf-api-"));
process.env.IAG_API_KEY = "clef-de-test";
process.env.IAG_MODEL = "modele-de-test";

let base; // http://localhost:<port> du serveur sous test
let sid;  // sessionId créé au premier test, réutilisé ensuite

before(async () => {
  const mock = await startMockGateway();
  process.env.IAG_BASE_URL = `http://localhost:${mock.port}/v1`;
  const { app } = require("../server");
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
});

const post = (url, body) =>
  fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("generate sans sessionId : crée la session, HTML intact malgré la gateway sale", async () => {
  const res = await post("/api/generate", { prompt: "Page d'accueil du lab" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.sessionId, "renvoie un sessionId");
  assert.equal(data.title, "Page d'accueil du lab");
  assert.equal(data.versionIndex, 0);
  assert.equal(data.version.html, PAGE, "le HTML ressort intact du stream sale");
  sid = data.sessionId;
});

test("la session est persistée et listée", async () => {
  const list = await (await fetch(base + "/api/sessions")).json();
  const meta = list.find((s) => s.id === sid);
  assert.ok(meta, "la session apparaît dans la liste");
  assert.equal(meta.versionCount, 1);
});

test("generate avec sessionId : itère et ajoute une version", async () => {
  const res = await post("/api/generate", { prompt: "Ajoute un pied de page", sessionId: sid, versionIndex: 0 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.sessionId, sid);
  assert.equal(data.versionIndex, 1);
  const full = await (await fetch(`${base}/api/sessions/${sid}`)).json();
  assert.equal(full.versions.length, 2);
  assert.equal(full.versions[0].prompt, "Page d'accueil du lab");
  assert.equal(full.versions[1].prompt, "Ajoute un pied de page");
});

test("versionIndex hors bornes : retombe sur la dernière version sans erreur", async () => {
  const res = await post("/api/generate", { prompt: "Encore une itération", sessionId: sid, versionIndex: 99 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).versionIndex, 2);
});

test("erreurs propres : 400 prompt manquant, 400 id malformé, 404 session inconnue", async () => {
  assert.equal((await post("/api/generate", {})).status, 400);
  assert.equal((await post("/api/generate", { prompt: "x", sessionId: "../hack" })).status, 400);
  assert.equal((await post("/api/generate", { prompt: "x", sessionId: "s_1_dead00" })).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/pas-un-id`)).status, 400);
  assert.equal((await fetch(`${base}/api/sessions/s_1_dead00`)).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/s_1_dead00`, { method: "DELETE" })).status, 404);
});

test("DELETE supprime la session", async () => {
  const res = await fetch(`${base}/api/sessions/${sid}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const list = await (await fetch(base + "/api/sessions")).json();
  assert.ok(!list.some((s) => s.id === sid));
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `node --test test/api.test.js`
Attendu : FAIL — `server.js` ne s'exporte pas (`app` undefined) et/ou `process.exit(1)`… selon l'ordre : l'échec précis importe peu, aucun test ne doit passer.

- [ ] **Step 3 : Modifier `server.js`**

3a. En tête, après `const path = require("path");` :

```js
const store = require("./store");
```

3b. Remplacer le handler `app.post("/api/generate", …)` complet (lignes ~90-165) par :

```js
app.post("/api/generate", async (req, res) => {
  const { prompt, sessionId, versionIndex } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Prompt manquant." });
  }

  // Le serveur est la source de vérité : on relit la session depuis le disque
  let session;
  if (sessionId != null) {
    if (!store.isValidId(sessionId)) {
      return res.status(400).json({ error: "Identifiant de session invalide." });
    }
    session = await store.loadSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable. Elle a peut-être été supprimée." });
    }
  } else {
    session = store.newSession(prompt); // rien n'est écrit tant que la génération n'a pas réussi
  }

  // Version active : l'index demandé s'il est valide, sinon la dernière
  const count = session.versions.length;
  const idx =
    Number.isInteger(versionIndex) && versionIndex >= 0 && versionIndex < count
      ? versionIndex
      : count - 1;
  const currentHtml = idx >= 0 ? session.versions[idx].html : null;

  // Reconstitue la conversation : historique + code courant + nouvelle instruction
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const turn of session.versions.map((v) => v.prompt).slice(-6)) {
    // On ne renvoie que les instructions passées (pas les gros HTML) pour limiter le contexte
    messages.push({ role: "user", content: turn });
  }
  if (currentHtml) {
    messages.push({
      role: "user",
      content: `Voici le code actuel de l'interface :\n\n${currentHtml}\n\nModification demandée : ${prompt}`,
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // On streame ENTRE ce serveur et le portail : tant que des chunks circulent,
    // le nginx de la gateway ne coupe pas la connexion (fix du 504).
    // Mais on parse le SSE de façon TOLÉRANTE : on ignore les ids de chunks,
    // on accumule simplement chaque delta de texte. C'est ce que le SDK
    // d'OpenDesign refuse de faire — et pourquoi lui plantait.
    const upstream = await fetch(`${PORTAL_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 16000,
        messages,
      }),
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      console.error(`[portail IAG] HTTP ${upstream.status} :`, raw.slice(0, 500));
      return res.status(502).json({
        error: `Le portail IAG a répondu ${upstream.status}. Détail : ${raw.slice(0, 300)}`,
      });
    }

    const text = await consumeStreamTolerantly(upstream);
    const html = extractHtml(text);
    if (!html.toLowerCase().includes("<html")) {
      return res.status(502).json({
        error: "Le modèle n'a pas renvoyé de HTML exploitable. Réessaie ou reformule.",
        rawPreview: text.slice(0, 300),
      });
    }

    // Succès seulement : on ajoute la version et on persiste (écriture atomique)
    const version = { prompt, html, createdAt: new Date().toISOString() };
    session.versions.push(version);
    session.updatedAt = version.createdAt;
    await store.saveSession(session);

    res.json({
      sessionId: session.id,
      title: session.title,
      versionIndex: session.versions.length - 1,
      version,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        error: `Le portail n'a pas répondu en ${TIMEOUT_MS / 1000}s. La gateway coupe peut-être les requêtes longues.`,
      });
    }
    console.error("[erreur]", err);
    res.status(500).json({ error: `Erreur réseau vers le portail : ${err.message}` });
  } finally {
    clearTimeout(timer);
  }
});
```

3c. Juste après ce handler, ajouter les endpoints sessions :

```js
app.get("/api/sessions", async (_req, res) => {
  res.json(await store.listSessions());
});

app.get("/api/sessions/:id", async (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: "Identifiant de session invalide." });
  }
  const session = await store.loadSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable. Elle a peut-être été supprimée." });
  }
  res.json(session);
});

app.delete("/api/sessions/:id", async (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: "Identifiant de session invalide." });
  }
  if (!(await store.deleteSession(req.params.id))) {
    return res.status(404).json({ error: "Session introuvable. Elle a peut-être été supprimée." });
  }
  res.json({ ok: true });
});
```

3d. Remplacer le bloc final `const PORT = …; app.listen(…)` par :

```js
module.exports = { app };

// Démarrage direct uniquement (les tests importent { app } sans écouter)
if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`EDF Design prêt → http://localhost:${PORT}`);
    console.log(`Portail : ${PORTAL_URL} · Modèle : ${MODEL} · Mode : stream tolérant (anti-504)`);
  });
}
```

- [ ] **Step 4 : Vérifier le succès**

Run : `npm test`
Attendu : PASS — les 7 tests store + les 7 tests API, 0 échec. Le test « HTML intact malgré la gateway sale » valide au passage la contrainte n°2 du PROJET.md.

---

### Task 4 : Front — sessions dans l'UI + rechargement auto

**Files:**
- Modify: `public/index.html` (CSS ~lignes 113-140, HTML de l'`<aside>` ~lignes 212-223, `<script>` ~lignes 252-365)
- Modify: `PROJET.md` (architecture, roadmap, tests)

**Interfaces:**
- Consumes: les 4 endpoints de Task 3 (contrats exacts ci-dessus).
- Produces: rien (feuille).

- [ ] **Step 1 : CSS** — dans le bloc `/* ---- Versions ---- */`, remplacer les deux premières règles (`.versions { … }` et `.versions h2 { … }`) par :

```css
  /* ---- Sessions & Versions ---- */
  .sessions {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    max-height: 38%;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .versions { flex: 1; overflow-y: auto; padding: 16px; }
  .sessions h2, .versions h2 { font-size: 12px; color: var(--text-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .panel-head h2 { margin-bottom: 0; }
  .btn-small { padding: 4px 10px; font-size: 12px; }
  .session-row { position: relative; }
  .session-row .version-item { padding-right: 36px; }
  .s-title { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-meta { display: block; font-family: var(--mono); font-size: 11px; color: var(--text-dim); margin-top: 3px; }
  .session-delete {
    position: absolute;
    top: 8px;
    right: 8px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    padding: 2px 8px;
    font-size: 14px;
    line-height: 1;
    border-radius: 6px;
  }
  .session-delete:hover, .session-delete:focus-visible { color: var(--danger); border-color: var(--danger); }
```

- [ ] **Step 2 : HTML** — remplacer le bloc `<div class="versions">…</div>` de l'`<aside>` par :

```html
    <div class="sessions">
      <div class="panel-head">
        <h2 id="sessionsTitle">Sessions</h2>
        <button class="btn-ghost btn-small" id="newSessionBtn">Nouveau design</button>
      </div>
      <div id="sessionList" role="list" aria-labelledby="sessionsTitle">
        <p class="empty">Aucune session enregistrée.</p>
      </div>
    </div>
    <div class="versions">
      <h2 id="versionsTitle">Versions</h2>
      <div id="versionList" role="list" aria-labelledby="versionsTitle">
        <p class="empty">Aucune version pour l'instant. La première génération apparaîtra ici.</p>
      </div>
    </div>
```

- [ ] **Step 3 : Script** — remplacer intégralement le contenu du `<script>` par :

```js
  const $ = (id) => document.getElementById(id);
  let sessions = [];          // métadonnées { id, title, createdAt, updatedAt, versionCount }
  let currentSessionId = null;
  let versions = [];          // cache d'affichage de la session chargée — le serveur fait foi
  let activeIndex = -1;
  let lastPrompt = "";
  let timerInterval = null;
  let currentBlobUrl = null;

  function setState(name) {
    ["idleState", "loadingState", "errorState"].forEach((s) => $(s).classList.add("hidden"));
    $("frame").classList.add("hidden");
    if (name === "frame") $("frame").classList.remove("hidden");
    else $(name).classList.remove("hidden");
  }

  function startTimer() {
    const start = Date.now();
    $("timer").textContent = "0 s";
    timerInterval = setInterval(() => {
      $("timer").textContent = Math.round((Date.now() - start) / 1000) + " s";
    }, 1000);
  }
  function stopTimer() { clearInterval(timerInterval); }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  /* ---- Sessions ---- */

  function renderSessions() {
    const list = $("sessionList");
    list.innerHTML = "";
    if (!sessions.length) {
      list.innerHTML = '<p class="empty">Aucune session enregistrée.</p>';
      return;
    }
    sessions.forEach((s) => {
      const row = document.createElement("div");
      row.className = "session-row";
      row.setAttribute("role", "listitem");

      const open = document.createElement("button");
      open.className = "version-item" + (s.id === currentSessionId ? " active" : "");
      open.innerHTML = '<span class="s-title"></span><span class="s-meta"></span>';
      open.querySelector(".s-title").textContent = s.title;
      open.querySelector(".s-meta").textContent = `${s.versionCount} version${s.versionCount > 1 ? "s" : ""} · ${fmtDate(s.updatedAt)}`;
      open.addEventListener("click", () => openSession(s.id));

      const del = document.createElement("button");
      del.className = "session-delete";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Supprimer la session ${s.title}`);
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteSession(s.id, s.title); });

      row.append(open, del);
      list.appendChild(row);
    });
  }

  async function loadSessionList() {
    try {
      const res = await fetch("/api/sessions");
      sessions = res.ok ? await res.json() : [];
    } catch { sessions = []; }
    renderSessions();
  }

  async function openSession(id) {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) {
      // Supprimée entre-temps (fichier retiré à la main) : on la retire de la liste
      sessions = sessions.filter((s) => s.id !== id);
      if (currentSessionId === id) newDesign(); else renderSessions();
      return;
    }
    const s = await res.json();
    currentSessionId = s.id;
    versions = s.versions;
    renderSessions();
    if (versions.length) selectVersion(versions.length - 1);
    else { activeIndex = -1; renderVersions(); setState("idleState"); }
  }

  function newDesign() {
    currentSessionId = null;
    versions = [];
    activeIndex = -1;
    renderVersions();
    renderSessions();
    setState("idleState");
    ["copyBtn", "downloadBtn", "openTabBtn"].forEach((id) => ($(id).disabled = true));
    $("previewTitle").textContent = "preview";
    $("prompt").focus();
  }

  async function deleteSession(id, title) {
    if (!confirm(`Supprimer la session « ${title} » et toutes ses versions ?`)) return;
    try { await fetch(`/api/sessions/${id}`, { method: "DELETE" }); } catch { /* déjà absente : on nettoie quand même l'UI */ }
    sessions = sessions.filter((s) => s.id !== id);
    if (currentSessionId === id) newDesign(); else renderSessions();
  }

  /* ---- Versions ---- */

  function renderVersions() {
    const list = $("versionList");
    list.innerHTML = "";
    if (!versions.length) {
      list.innerHTML = '<p class="empty">Aucune version pour l\'instant. La première génération apparaîtra ici.</p>';
      return;
    }
    versions.forEach((v, i) => {
      const btn = document.createElement("button");
      btn.className = "version-item" + (i === activeIndex ? " active" : "");
      btn.setAttribute("role", "listitem");
      btn.innerHTML = '<span class="v-num"></span><span class="v-prompt"></span>';
      btn.querySelector(".v-num").textContent = `v${i + 1}`;
      btn.querySelector(".v-prompt").textContent = v.prompt;
      btn.addEventListener("click", () => selectVersion(i));
      list.appendChild(btn);
    });
  }

  function selectVersion(i) {
    activeIndex = i;
    // Blob URL plutôt que srcdoc : contexte d'exécution normal, Tailwind CDN
    // fonctionne exactement comme dans "Ouvrir dans un onglet"
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(new Blob([versions[i].html], { type: "text/html" }));
    $("frame").src = currentBlobUrl;
    $("previewTitle").textContent = `v${i + 1} — ${versions[i].prompt.slice(0, 60)}`;
    ["copyBtn", "downloadBtn", "openTabBtn"].forEach((id) => ($(id).disabled = false));
    setState("frame");
    renderVersions();
  }

  /* ---- Génération ---- */

  async function generate() {
    const prompt = $("prompt").value.trim();
    if (!prompt) return;
    lastPrompt = prompt;
    $("generateBtn").disabled = true;
    setState("loadingState");
    startTimer();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          sessionId: currentSessionId,
          versionIndex: activeIndex >= 0 ? activeIndex : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur inconnue");

      const isNew = !currentSessionId;
      currentSessionId = data.sessionId;
      versions.push(data.version);
      if (isNew) {
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
      $("prompt").value = "";
      selectVersion(versions.length - 1);
      renderSessions();
    } catch (err) {
      $("errorMsg").textContent = err.message;
      setState("errorState");
    } finally {
      stopTimer();
      $("generateBtn").disabled = false;
    }
  }

  /* ---- Écouteurs ---- */

  $("generateBtn").addEventListener("click", generate);
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
  });
  $("retryBtn").addEventListener("click", () => {
    $("prompt").value = lastPrompt;
    generate();
  });
  $("newSessionBtn").addEventListener("click", newDesign);

  $("copyBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(versions[activeIndex].html);
    $("copyBtn").textContent = "Copié ✓";
    setTimeout(() => ($("copyBtn").textContent = "Copier le code"), 1500);
  });

  $("downloadBtn").addEventListener("click", () => {
    const blob = new Blob([versions[activeIndex].html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `edf-design-v${activeIndex + 1}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("openTabBtn").addEventListener("click", () => {
    const blob = new Blob([versions[activeIndex].html], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  });

  /* ---- Démarrage : recharge la session la plus récente ---- */
  (async function init() {
    await loadSessionList();
    if (sessions.length) openSession(sessions[0].id);
  })();
```

- [ ] **Step 4 : Vérification navigateur contre le mock gateway** (procédure PROJET.md)

```bash
node test/mock-gateway.js &
DATA_DIR=/tmp/edf-verif IAG_BASE_URL=http://localhost:9999/v1 IAG_API_KEY=x IAG_MODEL=x node server.js
```

Checklist dans le navigateur (`http://localhost:3000`) :
- [ ] Générer → la maquette du mock s'affiche dans la préview (Blob URL), une session apparaît dans « Sessions »
- [ ] Itérer (2e prompt) → v2 apparaît, le compteur de la session passe à « 2 versions »
- [ ] Rafraîchir la page → la session se recharge seule, v2 sélectionnée
- [ ] **Tuer le serveur (Ctrl-C), le relancer, rafraîchir → tout est encore là** (l'objectif de la feature)
- [ ] « Nouveau design » + générer → deuxième session en tête de liste, indépendante
- [ ] Rebasculer sur la première session → ses versions reviennent
- [ ] Supprimer une session (✕, confirmation en français) → disparaît ; si c'était la courante, retour à l'état vide
- [ ] Navigation clavier : Tab atteint sessions, versions, ✕ ; focus visible partout

Puis arrêter mock et serveur (`kill %1`).

- [ ] **Step 5 : Mettre à jour `PROJET.md`**

- Schéma architecture : ajouter `data/sessions/*.json` (persistance, un fichier par session, écriture atomique) et `store.js`.
- Section Roadmap : marquer l'item 1 comme fait (le retirer ou le cocher).
- Section Tests : mentionner `npm test` (node:test : store + intégration contre le mock gateway sale intégré `test/mock-gateway.js`).

- [ ] **Step 6 : Passe finale**

Run : `npm test`
Attendu : PASS complet. Relire le diff de `public/index.html` pour vérifier que la préview est toujours en Blob URL (contrainte n°3).

---

## Self-review du plan (fait à la rédaction)

- **Couverture spec :** stockage/modèle (Task 1), mock gateway (Task 2), API generate + CRUD + erreurs 400/404 + versionIndex hors bornes + rien-écrit-si-échec (Task 3), front sessions + rechargement auto + suppression + RGAA (Task 4), tests mock-gateway + restart (Tasks 3 et 4). ✓
- **Placeholders :** aucun — tout le code est complet. ✓
- **Cohérence des types :** `{ sessionId, title, versionIndex, version }` identique entre Task 3 (produit) et Task 4 (consommé) ; signatures store identiques entre Task 1 (produit) et Task 3 (consommé). ✓
