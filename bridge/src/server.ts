// Must load before anything imports tsyringe, which needs the Reflect metadata API.
import "reflect-metadata";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { buildContainer } from "./container.js";
import { logger } from "./logger.js";
import { TokenStore } from "./tokenStore.js";

// Crashes go through the logger too, so every line on stdout stays JSON.
// Unhandled promise rejections arrive here as well.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception; the bridge is stopping");
  process.exit(1);
});

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

// createApp resolves every controller, and with them every service, before the
// bridge listens: a broken registration stops it at startup.
const c = buildContainer(config, logger);
const app = createApp(c);
const installation = await c.resolve(TokenStore).installation();
if (installation) {
  logger.info({ appUserId: installation.appUserId }, "found the Linear install");
} else {
  logger.warn(`not installed in Linear yet; visit ${config.linear.publicUrl}/oauth/install`);
}

const server = createServer(app);

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
