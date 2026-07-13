/**
 * Tests d'intégration : serveur réel + mock gateway sale (Task 2).
 * Valide le contrat API ET que le parseur tolérant reconstitue le HTML
 * intact malgré les ids changeants / rafales / bruit SSE.
 */
const { test, before, after } = require("node:test");
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
let mockServer; // mock gateway, à fermer après
let mainServer; // serveur principal, à fermer après

before(async () => {
  mockServer = await startMockGateway();
  process.env.IAG_BASE_URL = `http://localhost:${mockServer.port}/v1`;
  const { app } = require("../server");
  mainServer = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://localhost:${mainServer.address().port}`;
});

after(async () => {
  if (mainServer) mainServer.close();
  if (mockServer?.server) mockServer.server.close();
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
