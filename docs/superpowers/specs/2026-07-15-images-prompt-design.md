# Images dans le prompt (wireframes, maquettes) — Design

**Date :** 2026-07-15 · **Statut :** validé · **Origine :** permettre au modèle de se baser sur un wireframe/une maquette uploadés pour générer l'écran.

## Faisabilité vérifiée

Test réel du 2026-07-15 contre le portail IAG (VPN actif) : le format vision OpenAI (`content` en tableau `[{type:"text"},{type:"image_url",image_url:{url:"data:image/png;base64,…"}}]`) est **accepté** et le modèle voit l'image (pixel rouge → réponse « Rouge »). Script rejouable : `test-vision.sh` à la racine (non tracké après la feature, voir Hors périmètre).

## Objectif

Joindre jusqu'à **3 images** (PNG/JPG/WebP) à un message du composer ; le modèle s'en sert comme référence visuelle. Les miniatures apparaissent dans la bulle du prompt dans le fil et survivent au rechargement.

## Ce qui ne change pas

- Contrat de **réponse** de `POST /api/generate`, parseur tolérant, `stream:true` portail, Blob URL préview, progression (`/api/progress/:id`), tiroir, RGAA, pas de dépendance, français partout, aucune mention « Claude ».

## Composer — ajout d'images

- Trois entrées : bouton **📎** (input file caché, `accept="image/png,image/jpeg,image/webp"`, multiple), **glisser-déposer** sur le composer, **collage ⌘V** dans le textarea (items image du presse-papier).
- **Miniatures** au-dessus du textarea (bande horizontale) : vignette ~56 px, bouton ✕ « Retirer l'image » par vignette (aria-label), focus visible.
- Limites : **3 images max par message** (au-delà → message d'aide sous le composer, image ignorée) ; fichier non-image ou > 10 Mo avant compression → même traitement. Les messages d'aide s'affichent dans une zone `role="status"` sous le composer et disparaissent au prochain ajout réussi.
- Les images en attente sont **vidées du composer à l'envoi** (elles suivent la génération dans `pending.images`, affichées dans la bulle). En cas de **succès**, elles finissent dans la version. En cas d'**échec**, elles sont **restituées à la file du composer** au moment où la carte d'erreur s'affiche — ainsi Réessayer comme une reformulation tapée à la main repartent avec les mêmes images (l'utilisateur peut aussi les retirer avant de relancer).

## Redimensionnement client (canvas)

- Avant ajout à la liste : décodage (`createImageBitmap`), réduction proportionnelle à **1568 px max sur le côté long** (jamais agrandie), ré-encodage **JPEG qualité 0.85** via canvas → data URL. (Les PNG avec transparence deviennent JPEG sur fond blanc — acceptable pour des wireframes/maquettes.)
- Ordre de grandeur résultant : ~100-400 Ko par image. 3 images + prompt + HTML restent très en dessous de la limite serveur existante (`express.json` à 10 Mo, inchangée).

## Contrat API — entrée uniquement

`POST /api/generate` accepte un champ optionnel `images: string[]` (data URLs). Validation serveur :
- tableau, **max 3** éléments, chaque élément commence par `data:image/(png|jpeg|webp);base64,` et fait **moins de 2 Mo** de chaîne ; sinon **400** `{ error }` français.
- Réponse inchangée : `{ sessionId, title, versionIndex, version }` — mais `version` porte désormais aussi `images` (voir Persistance).

## Construction du message portail (server.js)

- Si `images` non vide, le message utilisateur courant devient un **tableau** : `[{type:"text",text:<texte actuel, currentHtml inclus le cas échéant>}, {type:"image_url",image_url:{url:<dataUrl>}}, …]`. Sinon, chaîne comme aujourd'hui (zéro changement pour les vieux clients).
- **Les images ne partent qu'avec le message courant** : l'historique rejoué (`versions.map(v => v.prompt)`) reste du texte — on ne re-envoie jamais les images des tours précédents (coût tokens ; le HTML courant porte déjà le résultat).
- SYSTEM_PROMPT : ajout d'une ligne « Si des images sont fournies (wireframe, maquette, capture), elles sont la référence visuelle : reproduis fidèlement leur structure, leur hiérarchie et leur intention, en les traduisant en interface propre et accessible. »

## Persistance et fil

- `store` : la version enregistrée devient `{ prompt, html, createdAt, images? }` (data URLs compressées). Champ absent = version sans image ; **aucune migration** nécessaire (lecture tolérante).
- Fil : les miniatures s'affichent **dans la bulle du prompt** (pendant la génération via `pending.images`, et après via `version.images`), cliquables → ouvre l'image dans un onglet (Blob URL, cohérent avec la préview). `alt` : « Image jointe N ».
- Le compteur de la carte d'activité, le tiroir et la préview ne changent pas.

## Erreurs

- Serveur : 400 français si `images` invalide (format/nombre/taille). Les erreurs génération existantes (502/504) inchangées — la carte d'erreur du fil conserve les images en attente pour le retry.
- Front : fichiers refusés (type/taille/nombre) signalés sous le composer sans bloquer le reste.

## Tests

- API (mock gateway enrichi) : le mock expose le dernier corps reçu ; on vérifie (1) génération avec `images` → 200 et le corps envoyé au portail contient un `content` tableau avec le data URL ; (2) itération suivante SANS images → le corps ne contient plus d'`image_url` ; (3) `images` invalide (4 éléments / mauvais préfixe) → 400 ; (4) la version persistée contient `images` et `GET /api/sessions/:id` les renvoie.
- Store : une version avec `images` survit à save/load.
- Navigateur (contrôleur) : coller un vrai PNG, miniature, envoi, bulle avec miniature, rechargement, retrait ✕, limite à 3, fichier non-image refusé.

## Hors périmètre

Re-envoi des images des tours précédents, autres formats (PDF, SVG), annotation d'images, drag-drop sur la préview, `test-vision.sh` (sera supprimé du working tree, jamais commité).
