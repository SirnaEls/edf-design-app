/**
 * EDF Design — proxy vers le portail IAG (stream tolérant côté portail, JSON complet côté navigateur)
 * La clé API ne quitte jamais ce serveur.
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const store = require("./store");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORTAL_URL = process.env.IAG_BASE_URL; // URL de base du portail, /v1 inclus
const API_KEY = process.env.IAG_API_KEY;
const MODEL = process.env.IAG_MODEL; // nom exact du modèle côté portail
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 600000); // 10 min

if (!PORTAL_URL || !API_KEY || !MODEL) {
  const manquantes = [
    !PORTAL_URL && "IAG_BASE_URL",
    !API_KEY && "IAG_API_KEY",
    !MODEL && "IAG_MODEL",
  ].filter(Boolean);
  console.error(`
⚠️  Configuration incomplète — variable(s) manquante(s) : ${manquantes.join(", ")}

Crée un fichier nommé .env à la racine du projet (même dossier que server.js)
avec ces trois lignes, puis relance « npm start » :

  IAG_BASE_URL=…/v1        ← URL de base du portail IAG, /v1 inclus
  IAG_API_KEY=ta-clé-ici   ← ta clé API personnelle fournie par EDF
  IAG_MODEL=…              ← nom exact du modèle côté portail

Demande l'URL du portail et le nom du modèle à l'équipe si tu ne les as pas.
Rappel : le portail n'est joignable que depuis le réseau EDF (VPN activé).
`);
  process.exit(1);
}

const SYSTEM_PROMPT = `Tu es un design engineer senior. Tu génères des interfaces web complètes, production-ready, en un seul fichier HTML autonome.

Règles strictes :
- Réponds UNIQUEMENT avec le code HTML complet, du <!DOCTYPE html> à </html>. Aucun texte avant ou après, aucun bloc markdown.
- Un seul fichier : CSS dans <style>, JS dans <script>. Tailwind via CDN autorisé (<script src="https://cdn.tailwindcss.com"></script>).
- Design minimaliste et premium : références Linear, Raycast, Apple HIG. Espacements généreux, hiérarchie typographique nette, pas de décoration gratuite.
- Accessibilité RGAA : contrastes AA minimum, focus visible, labels sur tous les champs, navigation clavier fonctionnelle, attributs ARIA quand nécessaire.
- Contenu réaliste en français (jamais de lorem ipsum).
- Responsive par défaut.
- Si l'utilisateur fournit un code existant et demande une modification, renvoie le fichier COMPLET modifié, pas un diff.`;

/**
 * Consomme un flux SSE OpenAI-compatible en mode tolérant :
 * - ignore les ids de chunks (même s'ils changent en cours de route)
 * - ignore les chunks vides, malformés ou usage-only
 * - accepte les réponses non-JSON par ligne sans planter
 * - fonctionne même si la gateway bufferise et envoie tout d'un bloc
 * On accumule simplement tout delta.content rencontré.
 */
async function consumeStreamTolerantly(response, onProgress) {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // Les événements SSE sont séparés par des lignes ; on traite ligne à ligne
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop(); // garde la ligne incomplète pour le prochain chunk
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        // Cas stream OpenAI : choices[].delta.content
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") { text += delta; continue; }
        // Cas où la gateway renvoie finalement du non-stream malgré stream:true
        const full = json?.choices?.[0]?.message?.content;
        if (typeof full === "string") { text += full; continue; }
      } catch {
        // ligne non-JSON (keep-alive, commentaire SSE, bruit gateway) → on ignore
      }
    }
    if (onProgress) onProgress(text.length);
  }
  // Traite un éventuel reliquat (réponse non-stream envoyée d'un bloc sans saut de ligne final)
  const rest = buffer.trim();
  if (rest && rest !== "[DONE]") {
    try {
      const json = JSON.parse(rest.startsWith("data:") ? rest.slice(5).trim() : rest);
      const full = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.delta?.content;
      if (typeof full === "string") text += full;
    } catch { /* bruit final ignoré */ }
  }
  return text;
}

/** Extrait le HTML de la réponse (gère les fences markdown si le modèle en met malgré tout). */
function extractHtml(text) {
  if (!text) return "";
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const doc = text.indexOf("<!DOCTYPE");
  if (doc !== -1) return text.slice(doc).trim();
  return text.trim();
}

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

app.post("/api/generate", async (req, res) => {
  const { prompt, sessionId, versionIndex, generationId } = req.body || {};
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

  // Suivi de progression : optionnel, jamais bloquant (id invalide → ignoré)
  const trackId = isValidGenerationId(generationId) ? generationId : null;
  if (trackId) progressMap.set(trackId, { phase: "attente", chars: 0, startedAt: Date.now() });

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
    if (trackId) {
      const p = progressMap.get(trackId);
      if (p) p.phase = "enregistré";
    }

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
    if (trackId) progressMap.delete(trackId);
  }
});

// Express 4 ne rattrape pas les rejets des handlers async : sans ce garde-fou,
// toute erreur non prévue tuerait le processus.
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("[erreur route]", err);
  res.status(500).json({ error: "Erreur interne du serveur." });
});

app.get("/api/sessions", wrap(async (_req, res) => {
  res.json(await store.listSessions());
}));

app.get("/api/sessions/:id", wrap(async (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: "Identifiant de session invalide." });
  }
  const session = await store.loadSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable. Elle a peut-être été supprimée." });
  }
  res.json(session);
}));

app.delete("/api/sessions/:id", wrap(async (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: "Identifiant de session invalide." });
  }
  if (!(await store.deleteSession(req.params.id))) {
    return res.status(404).json({ error: "Session introuvable. Elle a peut-être été supprimée." });
  }
  res.json({ ok: true });
}));

app.get("/api/progress/:id", (req, res) => {
  const p = progressMap.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Génération inconnue ou terminée." });
  res.json({ phase: p.phase, chars: p.chars, elapsedMs: Date.now() - p.startedAt });
});

module.exports = { app };

// Démarrage direct uniquement (les tests importent { app } sans écouter)
if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  // 127.0.0.1 : l'outil (et la clé derrière) n'est joignable que depuis cette machine
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`EDF Design prêt → http://localhost:${PORT}`);
    console.log(`Portail : ${PORTAL_URL} · Modèle : ${MODEL} · Mode : stream tolérant (anti-504)`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`
⚠️  Le port ${PORT} est déjà utilisé — l'outil tourne probablement déjà.
Vérifie http://localhost:${PORT} dans ton navigateur, ou lance sur un autre
port : PORT=3001 npm start
`);
      process.exit(1);
    }
    throw err;
  });
}
