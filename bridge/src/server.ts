import { createServer } from "node:http";
import { ConfigError, loadConfig, type Config } from "./config.js";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`${err.message}\nThe bridge will not start until these are fixed.`);
  process.exit(1);
}
const { port } = config;
console.log(`loaded role ${config.role.name}`);

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://bridge");
  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  res.writeHead(404).end();
});

// Listen on every interface: the tunnel reaches the bridge over the Compose network.
server.listen(port, "0.0.0.0", () => {
  console.log(`bridge listening on :${port}`);
});

// tini forwards stop signals, so `docker compose down` closes the server cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
