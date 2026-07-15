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

test("generationId déjà en cours : la 2e génération n'écrase pas le suivi de la 1re", async () => {
  const gid = `test-doublon-${Date.now()}`;
  const p1 = post("/api/generate", { prompt: "Page A", generationId: gid });

  // Attend que la 1re génération soit suivie, puis laisse le temps s'accumuler
  let vivant = false;
  for (let i = 0; i < 200 && !vivant; i++) {
    await new Promise((r) => setTimeout(r, 5));
    vivant = (await fetch(`${base}/api/progress/${gid}`)).ok;
  }
  assert.ok(vivant, "le suivi de la 1re génération doit être enregistré");
  await new Promise((r) => setTimeout(r, 60));

  // Mesure fraîche JUSTE avant la 2e requête : elapsedMs vaut maintenant ≥ 60 ms
  const prAvant = await fetch(`${base}/api/progress/${gid}`);

  const p2 = post("/api/generate", { prompt: "Page B", generationId: gid });
  await new Promise((r) => setTimeout(r, 25)); // < aux ~60 ms accumulés : un reset ferait reculer elapsedMs

  const prApres = await fetch(`${base}/api/progress/${gid}`);
  if (prAvant.ok && prApres.ok) {
    const avant = await prAvant.json();
    const apres = await prApres.json();
    assert.ok(
      apres.elapsedMs >= avant.elapsedMs,
      `le suivi de la 1re a été réinitialisé (${apres.elapsedMs} ms < ${avant.elapsedMs} ms)`
    );
  }

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

test("images : transmises au portail en content tableau, persistées, jamais rejouées", async () => {
  const img = "data:image/png;base64," + "A".repeat(100);
  const res = await post("/api/generate", { prompt: "Page depuis wireframe", images: [img] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.version.images, [img], "la version renvoyée porte les images");

  const corps = mockServer.dernierCorps();
  const dernier = corps.messages[corps.messages.length - 1];
  assert.ok(Array.isArray(dernier.content), "message courant en tableau (format vision)");
  assert.equal(dernier.content[0].type, "text");
  assert.ok(
    dernier.content.some((p) => p.type === "image_url" && p.image_url.url === img),
    "l'image est jointe au message courant"
  );

  const full = await (await fetch(`${base}/api/sessions/${data.sessionId}`)).json();
  assert.deepEqual(full.versions[0].images, [img], "persistée sur disque");

  // Itération suivante SANS images : l'ancienne image ne repart pas au portail
  const res2 = await post("/api/generate", { prompt: "Ajoute un titre", sessionId: data.sessionId });
  assert.equal(res2.status, 200);
  assert.ok(
    !JSON.stringify(mockServer.dernierCorps().messages).includes("image_url"),
    "les images des tours précédents ne sont jamais rejouées"
  );
  assert.equal((await res2.json()).version.images, undefined, "pas de champ images sans image");
});

test("images invalides : 400 (nombre, type, forme)", async () => {
  const img = "data:image/png;base64,AAAA";
  assert.equal((await post("/api/generate", { prompt: "x", images: [img, img, img, img] })).status, 400);
  assert.equal((await post("/api/generate", { prompt: "x", images: ["data:text/html;base64,AAAA"] })).status, 400);
  assert.equal((await post("/api/generate", { prompt: "x", images: "pas-un-tableau" })).status, 400);

  const trop = "data:image/png;base64," + "A".repeat(2 * 1024 * 1024);
  assert.equal((await post("/api/generate", { prompt: "x", images: [trop] })).status, 400);
});
