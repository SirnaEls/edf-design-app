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

test("loadSession : schéma invalide (pas de versions) ignoré comme corrompu", async () => {
  const s = store.newSession("session au schéma invalide");
  delete s.versions;
  await fs.writeFile(path.join(store.DATA_DIR, `${s.id}.json`), JSON.stringify(s), "utf8");

  assert.equal(await store.loadSession(s.id), null);

  const list = await store.listSessions();
  assert.ok(!list.some((x) => x.id === s.id), "listSessions ignore le fichier au schéma invalide sans planter");
});

test("deleteSession : true puis la session disparaît ; false si inconnue", async () => {
  const s = store.newSession("à supprimer");
  await store.saveSession(s);
  assert.equal(await store.deleteSession(s.id), true);
  assert.equal(await store.loadSession(s.id), null);
  assert.equal(await store.deleteSession(s.id), false);
  assert.equal(await store.deleteSession("../hack"), false);
});

test("une version avec images survit à save/load", async () => {
  const s = store.newSession("Wireframe d'accueil");
  s.versions.push({
    prompt: "Wireframe d'accueil",
    html: "<!DOCTYPE html><html></html>",
    createdAt: new Date().toISOString(),
    images: ["data:image/jpeg;base64,QUJD"],
  });
  await store.saveSession(s);
  const relu = await store.loadSession(s.id);
  assert.deepEqual(relu.versions[0].images, ["data:image/jpeg;base64,QUJD"]);
});
