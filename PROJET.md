# EDF Design — contexte projet

Alternative interne aux outils de design IA pour le lab EDF. Génère des interfaces web (HTML autonome + Tailwind CDN, RGAA) via le portail IAG EDF (gateway OpenAI-compatible interne).

## Architecture

```
public/index.html  →  POST /api/generate  →  server.js  →  Portail IAG (stream:true, parseur tolérant)
     (front)         GET/DELETE /api/sessions*  (Express)      (SSE sale accepté)
                              │
                              ▼
                     store.js → data/sessions/*.json
                     (un fichier par session, écriture atomique tmp+rename)
```

- **server.js** : proxy Express. La clé API ne quitte JAMAIS le serveur. Source de vérité des sessions : relit toujours le disque via `store.js`, le front n'envoie ni `currentHtml` ni `history`.
- **store.js** : persistance des sessions en JSON sur disque (`data/sessions/<id>.json`). Un fichier par session (une session corrompue n'affecte pas les autres), écriture atomique (fichier `.tmp` puis `rename`) pour survivre à un arrêt du serveur en pleine écriture.
- **public/index.html** : front vanilla (pas de framework) — prompt, préview iframe (Blob URL), liste des sessions (rechargement auto au démarrage), historique de versions, export.
- **.env** : `IAG_BASE_URL`, `IAG_API_KEY`, `IAG_MODEL`, `PORT`, `TIMEOUT_MS`, `DATA_DIR` (optionnel, surcharge l'emplacement de `data/sessions/`). Jamais commité.

## Contraintes gateway — NE PAS CASSER

Ces trois décisions résultent de bugs réels rencontrés et résolus. Toute modification doit les préserver :

1. **L'appel au portail DOIT être en `stream: true`.** En non-stream, le nginx de la gateway coupe la connexion silencieuse → 504 Gateway Time-out. Le flux de chunks maintient la connexion en vie.
2. **Le parseur SSE (`consumeStreamTolerantly`) DOIT rester tolérant.** La gateway produit un stream non conforme : ids de chunks qui changent en cours de route, rafales bufferisées, lignes de bruit, chunks usage-only. On ignore les ids et on accumule tout `delta.content`. C'est précisément pourquoi OpenDesign (SDK Vercel AI, strict) plantait avec "text part chatcmpl-... not found". Ne jamais remplacer par un SDK strict.
3. **La préview DOIT passer par une Blob URL, pas `srcdoc` + sandbox.** Un iframe sandboxé sans `allow-same-origin` a une origine opaque → le script Tailwind CDN crashe sur `localStorage` → HTML brut sans style. La Blob URL donne un contexte d'exécution normal.

## Conventions

- Français partout (UI, erreurs, commentaires).
- Design de l'outil : dark, minimaliste, références Linear/Raycast. Variables CSS dans `:root` de index.html.
- Accessibilité RGAA : focus visible, labels, contrastes AA — sur l'outil ET dans le SYSTEM_PROMPT des générations.
- Pas de dépendance ajoutée sans nécessité : express + dotenv suffisent. Le front reste vanilla.
- Production-ready uniquement, pas de pseudocode.

## Le SYSTEM_PROMPT (server.js)

C'est le levier qualité n°1 des générations. Il impose : fichier HTML unique complet, Tailwind CDN, minimalisme premium, RGAA, contenu réaliste en français, fichier COMPLET renvoyé lors des itérations (pas de diff). Pour spécialiser l'outil (design system Self4All, règles Figma-ready), enrichir ce prompt.

## Roadmap envisagée

1. ~~Persistance des versions côté serveur (JSON sur disque) — survivre aux restarts.~~ Fait : `store.js` + sessions/versions dans l'UI.
2. Injection de design systems par projet (Self4All, SI'Nergie) — sélecteur dans l'UI, fragments de system prompt.
3. Export direct .zip multi-fichiers si les générations dépassent le fichier unique.

## Tests

`npm test` (node:test) : couvre `store.js` (persistance, écriture atomique, ids) et un test d'intégration API contre un mock gateway sale intégré (`test/mock-gateway.js` : ids de chunks changeants, rafales bufferisées, bruit SSE, chunk usage-only). Vérifie que `POST /api/generate` et les routes `GET/DELETE /api/sessions*` respectent le contrat malgré ce stream non conforme.

Pour une vérification manuelle en conditions réelles (navigateur, redémarrage du serveur) :
```bash
node test/mock-gateway.js &
DATA_DIR=/tmp/edf-verif IAG_BASE_URL=http://localhost:9999/v1 IAG_API_KEY=x IAG_MODEL=x node server.js
```
Générer, itérer, rafraîchir la page, puis couper et relancer le serveur (Ctrl-C) : les sessions et versions doivent survivre.

## Sécurité

- La clé IAG est une credential EDF : uniquement dans `.env` local, jamais en dur, jamais commitée, jamais loggée.
- L'outil est destiné à un usage local / réseau interne EDF. Pas d'exposition publique sans ajout d'auth.
