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
