# EDF Design

Alternative interne aux outils de design IA. Génère des interfaces web (HTML autonome, Tailwind, RGAA) via le portail IAG EDF.

**Architecture "stream tolérant"** : le serveur streame avec le portail (obligatoire — le nginx de la gateway coupe en 504 les connexions silencieuses du mode non-stream), mais parse le SSE de façon tolérante : ids de chunks ignorés, rafales bufferisées acceptées, bruit filtré. Le navigateur, lui, reçoit un simple JSON complet. C'est exactement ce que le SDK strict d'OpenDesign refusait de faire.

## Démarrage (3 étapes)

```bash
# 1. Installer (une seule fois)
npm install

# 2. Configurer : crée un fichier .env à la racine avec
#    IAG_BASE_URL=…/v1   (URL de base du portail IAG, /v1 inclus)
#    IAG_API_KEY=…       (ta clé API fournie par EDF)
#    IAG_MODEL=…         (nom exact du modèle côté portail)
#    PORT et TIMEOUT_MS optionnels (défauts : 3000 / 600000)

# 3. Lancer
npm start
```

Puis ouvre **http://localhost:3000**.

## Utilisation

1. Décris une interface dans le champ de gauche → **Générer** (⌘/Ctrl+Entrée).
2. La préview s'affiche dans l'iframe (20–60 s par génération, c'est normal : le résultat arrive d'un bloc une fois la génération terminée).
3. Pour itérer : garde la version sélectionnée, décris la modification, régénère. Le code courant est renvoyé au modèle avec ta consigne.
4. Chaque génération crée une **version** dans l'historique — clique pour revenir en arrière.
5. **Copier le code** ou **Télécharger .html** pour récupérer le livrable.

## Comment c'est câblé

```
Navigateur ── /api/generate ──► server.js ── stream:true (parseur tolérant) ──► Portail IAG
   ▲                                │              chunks sales acceptés ✓
   └──── JSON { html } ◄────────────┘              nginx maintenu en vie ✓
```

- La clé API reste côté serveur (`.env`), jamais exposée au navigateur.
- Le flux circule en continu avec le portail → pas de coupure nginx (504).
- Le parseur accumule tout `delta.content` sans vérifier les ids de chunks → immunisé contre les streams malformés de la gateway.
- Timeout global à 10 min (configurable via `TIMEOUT_MS`).

## Dépannage

| Symptôme | Cause probable | Fix |
|---|---|---|
| `502 — Le portail IAG a répondu 401/403` | Clé invalide ou header d'auth différent | Vérifie la clé ; si le portail n'utilise pas `Authorization: Bearer`, adapte le header dans `server.js` |
| `502 — 404` | Mauvais chemin d'API | Vérifie que `IAG_BASE_URL` se termine bien par `/v1` et que le portail expose `/chat/completions` |
| `502 — 504 Gateway Time-out (nginx)` | La gateway coupe même le stream (rare) | Le flux circule normalement en continu ; si ça arrive quand même, réduis la complexité du prompt et note la durée avant coupure |
| `504 — pas de réponse en 600s` | Timeout global côté outil | Augmente `TIMEOUT_MS` dans `.env` |
| `Le modèle n'a pas renvoyé de HTML` | Le modèle a bavardé au lieu de coder | Relance ; si récurrent, le modèle configuré est peut-être trop petit |

## Personnalisation

Le system prompt design est dans `server.js` (`SYSTEM_PROMPT`). C'est là que tu injectes ton design system, tes règles de markup Figma-ready, ou les contraintes spécifiques Self4All / SI'Nergie.
