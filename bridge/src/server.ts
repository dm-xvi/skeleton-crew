import { createServer } from "node:http";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { logger } from "./logger.js";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  logger.error(
    { problems: err.problems },
    "invalid configuration; the bridge will not start until these are fixed",
  );
  process.exit(1);
}
const { port } = config;
logger.info({ role: config.role.name }, "loaded role");

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
  logger.info({ port }, "bridge listening");
});

// tini forwards stop signals, so `docker compose down` closes the server cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  });
}
