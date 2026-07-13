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
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[store] session ${id} illisible :`, err.message);
    }
    return null;
  }
  // JSON valide mais schéma inattendu (pas de tableau versions, etc.) :
  // on l'ignore comme un fichier corrompu plutôt que de propager une forme
  // invalide qui ferait planter listSessions() ou /api/generate en aval.
  if (!parsed || !Array.isArray(parsed.versions)) {
    console.error(`[store] session ${id} au schéma invalide (versions manquant) : ignorée`);
    return null;
  }
  return parsed;
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
