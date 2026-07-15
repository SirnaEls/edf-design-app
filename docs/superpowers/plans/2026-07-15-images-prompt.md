# Images dans le prompt — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Joindre jusqu'à 3 images (wireframes/maquettes) à un message ; le modèle les reçoit au format vision OpenAI (validé contre le portail le 2026-07-15) ; miniatures dans le composer puis dans la bulle du fil, persistées dans la version.

**Architecture:** Le front compresse les images via canvas (1568 px max, JPEG 0.85) et les envoie en data URLs dans un champ `images` optionnel de `POST /api/generate`. Le serveur valide (3 max, préfixe data:image, < 2 Mo chacune) et construit le message utilisateur courant en tableau `[{type:"text"},{type:"image_url"}…]` — jamais rejoué aux tours suivants. La version persistée gagne un champ `images?` (lecture tolérante, zéro migration).

**Tech Stack:** Node ≥18, Express, node:test, front vanilla. Spec : `docs/superpowers/specs/2026-07-15-images-prompt-design.md`.

## Global Constraints

- Contrat de **réponse** de `POST /api/generate` inchangé (la `version` renvoyée porte simplement `images` quand il y en a).
- `stream: true` portail + logique de `consumeStreamTolerantly` intouchée. Blob URL préview intouchée.
- Pas de dépendance. Français partout (UI, erreurs, commentaires). RGAA (labels/aria sur le trombone et les ✕, zone d'aide `role="status"`, focus visible).
- Aucune mention « Claude » — fichiers ET messages de commit (pas de trailer Co-Authored-By).
- Limite `express.json` existante (10 Mo) inchangée. Historique rejoué (`versions.map(v => v.prompt)`) : texte seul, ne jamais y injecter d'images.

---

### Task 1 : Backend — champ `images`, message vision, persistance, tests

**Files:**
- Modify: `server.js` (destructuration l.109 ; validation après le check prompt ; construction du message l.158-171 ; `const version =` l.225 ; SYSTEM_PROMPT l.41-50)
- Modify: `test/mock-gateway.js` (capture du dernier corps reçu)
- Test: `test/api.test.js` (2 tests ajoutés), `test/store.test.js` (1 test ajouté)

**Interfaces:**
- Consumes: handler `/api/generate` existant, `startMockGateway()` (Task 2 du plan précédent).
- Produces (utilisé par la Task 2, le front) :
  - `POST /api/generate` accepte `images?: string[]` (data URLs `^data:image/(png|jpeg|webp);base64,`, **max 3**, chaque chaîne **< 2 Mo**) → sinon **400** `{ error: "Images invalides : 3 maximum, PNG/JPEG/WebP en data URL, 2 Mo chacune." }`.
  - La `version` renvoyée (et persistée) porte `images` uniquement quand il y en a.
  - `startMockGateway()` résout désormais `{ server, port, dernierCorps }` où `dernierCorps()` renvoie le dernier corps JSON reçu par le mock (ou null).

- [ ] **Step 1 : Écrire les tests qui échouent**

1a. Dans `test/api.test.js`, à la fin :

```js
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
});
```

1b. Dans `test/store.test.js`, à la fin (mêmes helpers que les tests existants du fichier — s'y conformer) :

```js
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
```

- [ ] **Step 2 : Vérifier l'échec**

Run : `npm test`
Attendu : FAIL — `mockServer.dernierCorps is not a function` et/ou `data.version.images` undefined. Les 18 tests existants restent verts.

- [ ] **Step 3 : Enrichir le mock** — dans `test/mock-gateway.js`, fonction `startMockGateway` :

Remplacer `req.resume(); // consomme le corps sans le lire` par :

```js
    // Capture le corps pour que les tests vérifient CE QUE le serveur envoie au portail
    let corps = "";
    req.on("data", (c) => (corps += c));
    req.on("end", () => {
      try { dernierCorps = JSON.parse(corps); } catch { dernierCorps = null; }
    });
```

Déclarer `let dernierCorps = null;` en tête de `startMockGateway` (avant `const server = …`), et remplacer la résolution finale par :

```js
  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({ server, port: server.address().port, dernierCorps: () => dernierCorps })
    );
  });
```

- [ ] **Step 4 : Modifier `server.js`**

4a. Destructuration (l.109) :

```js
  const { prompt, sessionId, versionIndex, generationId, images } = req.body || {};
```

4b. Juste après le bloc `if (!prompt || typeof prompt !== "string") { … }` :

```js
  // Images jointes : optionnelles, bornées (le front compresse déjà, ceci est la ceinture)
  const PREFIXE_IMAGE = /^data:image\/(png|jpeg|webp);base64,/;
  if (images != null) {
    const invalide =
      !Array.isArray(images) ||
      images.length > 3 ||
      images.some((i) => typeof i !== "string" || !PREFIXE_IMAGE.test(i) || i.length > 2 * 1024 * 1024);
    if (invalide) {
      return res.status(400).json({ error: "Images invalides : 3 maximum, PNG/JPEG/WebP en data URL, 2 Mo chacune." });
    }
  }
```

4c. Remplacer le bloc de construction du message courant (l.164-171, le `if (currentHtml) { … } else { … }`) par :

```js
  const texteCourant = currentHtml
    ? `Voici le code actuel de l'interface :\n\n${currentHtml}\n\nModification demandée : ${prompt}`
    : prompt;
  if (images && images.length) {
    // Format vision OpenAI (validé contre le portail IAG le 2026-07-15).
    // Les images n'accompagnent QUE le message courant : l'historique rejoué
    // reste du texte, on ne re-paye jamais leurs tokens aux tours suivants.
    messages.push({
      role: "user",
      content: [
        { type: "text", text: texteCourant },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    });
  } else {
    messages.push({ role: "user", content: texteCourant });
  }
```

4d. La version persistée (l.225) :

```js
    const version = {
      prompt,
      html,
      createdAt: new Date().toISOString(),
      ...(images && images.length ? { images } : {}),
    };
```

4e. SYSTEM_PROMPT : ajouter cette ligne à la liste « Règles strictes » (avant la dernière règle) :

```
- Si des images sont fournies (wireframe, maquette, capture), elles sont la référence visuelle : reproduis fidèlement leur structure, leur hiérarchie et leur intention, en les traduisant en interface propre et accessible.
```

- [ ] **Step 5 : Vérifier le succès**

Run : `npm test`
Attendu : PASS — 21 tests (8 store + 13 api), 0 échec, sortie propre, sortie de process nette.

- [ ] **Step 6 : Commit**

```bash
git add server.js test/mock-gateway.js test/api.test.js test/store.test.js
git commit -m "feat: images jointes au prompt — format vision vers le portail, persistance"
```

---

### Task 2 : Front — pièces jointes du composer, miniatures dans le fil

**Files:**
- Modify: `public/index.html` (CSS `.composer*` l.146-168 ; HTML composer l.306-310 ; JS : nouvelles fonctions pièces jointes, `generate()`, `renderPending()`, `renderThread()`, écouteurs)

**Interfaces:**
- Consumes: `POST /api/generate` avec `images?: string[]` (Task 1) ; `version.images?` renvoyé/persisté ; état `pending` et fonctions `renderThread`/`renderPending`/`majCarteActivite` existants.
- Produces: état final de la feature.

- [ ] **Step 1 : CSS** — après le bloc `.composer .btn-primary { … }` (l.168), ajouter :

```css
  .composer .btn-attach { padding: 10px 12px; font-size: 15px; line-height: 1.5; }
  .attachments {
    display: flex;
    gap: 8px;
    padding: 10px 16px 0;
  }
  .attachments.hidden { display: none; }
  .attach-item { position: relative; }
  .attach-item img {
    width: 56px; height: 56px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
    display: block;
  }
  .attach-remove {
    position: absolute; top: -6px; right: -6px;
    width: 20px; height: 20px;
    padding: 0;
    border-radius: 50%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 11px; line-height: 1;
  }
  .attach-remove:hover, .attach-remove:focus-visible { color: var(--danger); border-color: var(--danger); }
  .composer-hint {
    padding: 8px 16px 0;
    font-size: 12px;
    color: var(--danger);
    line-height: 1.4;
  }
  .composer-hint:empty { display: none; }
  .composer.drag-over textarea { outline: 2px dashed var(--accent); outline-offset: 1px; }
  .bubble .bubble-images { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .bubble .bubble-images img {
    width: 72px; height: 72px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
    cursor: pointer;
    display: block;
  }
```

Et sur la règle `.composer { … }` existante, remplacer `border-top: 1px solid var(--border);` par rien (la bordure monte sur la zone) puis englober : voir Step 2 (le conteneur `.composer-zone` prend `border-top: 1px solid var(--border); flex-shrink: 0;` — ajouter cette règle) :

```css
  .composer-zone { border-top: 1px solid var(--border); flex-shrink: 0; }
```

(`.composer` garde son `display:flex; gap; padding; align-items` mais perd `flex-shrink` et `border-top`.)

- [ ] **Step 2 : HTML** — remplacer le bloc composer (l.306-310) par :

```html
    <div class="composer-zone">
      <div class="attachments hidden" id="attachments"></div>
      <p class="composer-hint" id="composerHint" role="status"></p>
      <div class="composer">
        <button class="btn-ghost btn-attach" id="attachBtn" aria-label="Joindre une image (wireframe, maquette)" title="Joindre une image">📎</button>
        <input type="file" id="fileInput" class="sr-only" accept="image/png,image/jpeg,image/webp" multiple />
        <label for="prompt" class="sr-only">Décris l'interface ou la modification</label>
        <textarea id="prompt" rows="1" placeholder="Décris l'interface ou la modification…"></textarea>
        <button class="btn-primary" id="generateBtn">Générer</button>
      </div>
    </div>
```

- [ ] **Step 3 : JS — pièces jointes** (nouvelle section avant `/* ---- Génération ---- */`) :

```js
  /* ---- Pièces jointes (wireframes, maquettes) ---- */

  const MAX_IMAGES = 3;
  const MAX_COTE = 1568; // côté long envoyé au modèle : suffisant, borne les tokens
  let imagesEnAttente = []; // data URLs JPEG compressées

  function hint(msg) { $("composerHint").textContent = msg || ""; }

  async function compresserImage(fichier) {
    const bmp = await createImageBitmap(fichier);
    const ratio = Math.min(1, MAX_COTE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * ratio);
    canvas.height = Math.round(bmp.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // les PNG transparents deviennent des JPEG sur fond blanc
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function ajouterImages(fichiers) {
    for (const f of fichiers) {
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { hint(`« ${f.name} » ignoré : seuls PNG, JPEG et WebP sont acceptés.`); continue; }
      if (f.size > 10 * 1024 * 1024) { hint(`« ${f.name} » ignoré : fichier trop lourd (10 Mo max).`); continue; }
      if (imagesEnAttente.length >= MAX_IMAGES) { hint(`3 images maximum par message.`); break; }
      try {
        imagesEnAttente.push(await compresserImage(f));
        hint("");
      } catch {
        hint(`Impossible de lire « ${f.name} ».`);
      }
    }
    renderAttachments();
  }

  function renderAttachments() {
    const zone = $("attachments");
    zone.innerHTML = "";
    zone.classList.toggle("hidden", imagesEnAttente.length === 0);
    imagesEnAttente.forEach((url, i) => {
      const item = document.createElement("div");
      item.className = "attach-item";
      const img = document.createElement("img");
      img.src = url;
      img.alt = `Image jointe ${i + 1}`;
      const del = document.createElement("button");
      del.className = "attach-remove";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Retirer l'image ${i + 1}`);
      del.addEventListener("click", () => {
        imagesEnAttente.splice(i, 1);
        renderAttachments();
      });
      item.append(img, del);
      zone.appendChild(item);
    });
  }

  function ouvrirImage(dataUrl) {
    // Chrome bloque les data URLs en navigation directe : on passe par une Blob URL
    fetch(dataUrl).then((r) => r.blob()).then((b) => window.open(URL.createObjectURL(b), "_blank"));
  }

  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    ajouterImages([...$("fileInput").files]);
    $("fileInput").value = "";
  });
  $("prompt").addEventListener("paste", (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      ajouterImages(imgs.map((it) => it.getAsFile()).filter(Boolean));
    }
  });
  const composerEl = document.querySelector(".composer");
  composerEl.addEventListener("dragover", (e) => { e.preventDefault(); composerEl.classList.add("drag-over"); });
  composerEl.addEventListener("dragleave", () => composerEl.classList.remove("drag-over"));
  composerEl.addEventListener("drop", (e) => {
    e.preventDefault();
    composerEl.classList.remove("drag-over");
    ajouterImages([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")));
  });
```

- [ ] **Step 4 : JS — `generate()`** :

4a. Après `const gid = crypto.randomUUID();`, ajouter `const imagesEnvoyees = imagesEnAttente;` puis dans l'objet `pending`, ajouter le champ `images: imagesEnvoyees,`. Juste après la création de `pending` (avant `renderThread()`), vider la file :

```js
    imagesEnAttente = [];
    renderAttachments();
    hint("");
```

4b. Dans le body du fetch, ajouter après `generationId: gid,` :

```js
          images: imagesEnvoyees.length ? imagesEnvoyees : undefined,
```

4c. Dans le `catch`, branche « toujours sur cette session » (celle qui fait `pending.error = err.message;`), restituer les images à la file AVANT `renderThread()` :

```js
        // Restitue les images au composer : Réessayer comme une reformulation
        // repartent avec — sauf si l'utilisateur en a déjà rajouté entre-temps
        if (!imagesEnAttente.length) {
          imagesEnAttente = pending.images || [];
          renderAttachments();
        }
```

- [ ] **Step 5 : JS — miniatures dans les bulles** :

5a. Dans `renderThread()`, la bulle de version devient (remplacer les 3 lignes `const bubble = …; bubble.className = …; bubble.textContent = …;` par un appel) :

```js
      thread.appendChild(creerBulle(v.prompt, v.images));
```

et ajouter à côté de `renderPending` :

```js
  function creerBulle(texte, images) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = texte;
    if (images && images.length) {
      const zone = document.createElement("div");
      zone.className = "bubble-images";
      images.forEach((url, i) => {
        const img = document.createElement("img");
        img.src = url;
        img.alt = `Image jointe ${i + 1}`;
        img.addEventListener("click", () => ouvrirImage(url));
        zone.appendChild(img);
      });
      bubble.appendChild(zone);
    }
    return bubble;
  }
```

5b. Dans `renderPending()`, remplacer le bloc `if (pending.prompt) { const bubble = …; …; thread.appendChild(bubble); }` par :

```js
    if (pending.prompt) thread.appendChild(creerBulle(pending.prompt, pending.images));
```

- [ ] **Step 6 : Vérifier**

Run : `npm test` → 21 tests verts (rien côté serveur ne change dans cette tâche).
Syntax : `sed -n '/<script>/,/<\/script>/p' public/index.html | sed '1d;$d' > /tmp/uimg.js && node --check /tmp/uimg.js`.
Greps : `grep -c "imagesEnAttente" public/index.html` ≥ 6 ; `grep -c "creerBulle" public/index.html` → 3.
Smoke réel : mock + serveur (comme d'habitude), puis `curl -s -X POST localhost:3000/api/generate -H "Content-Type: application/json" -d '{"prompt":"t","images":["data:image/png;base64,QUJD"]}' | grep -c images` → ≥ 1.

- [ ] **Step 7 : Commit**

```bash
git add public/index.html
git commit -m "feat: pièces jointes du composer — trombone, glisser-déposer, collage, miniatures dans le fil"
```

---

## Vérification finale (contrôleur)

Passe navigateur Chrome contre le mock : coller un vrai PNG (⌘V), miniature + ✕, envoi → bulle avec miniature + compteur, rechargement (miniature persistée), clic miniature → onglet, limite 3, fichier non-image refusé avec message, échec de génération → images restituées au composer. Puis revue finale de branche, merge, push. Supprimer `test-vision.sh` du working tree avant la clôture (jamais commité).
