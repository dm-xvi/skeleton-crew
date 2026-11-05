// Must load before anything imports tsyringe, which needs the Reflect metadata API.
import "reflect-metadata";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { buildContainer } from "./container.js";
import { LinearOAuth } from "./linearOAuth.js";
import { logger } from "./logger.js";
import { TokenStore } from "./tokenStore.js";
import { CLOCK } from "./tokens.js";

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

// Resolved before listening, so a broken registration stops the bridge at startup.
const c = buildContainer(config, logger);
const oauth = c.resolve(LinearOAuth);
const tokens = c.resolve(TokenStore);
const installation = await tokens.installation();
if (installation) {
  logger.info({ appUserId: installation.appUserId }, "found the Linear install");
} else {
  logger.warn(`not installed in Linear yet; visit ${config.linear.publicUrl}/oauth/install`);
}

const server = createServer(createApp({ config, oauth, tokens, logger, now: c.resolve(CLOCK) }));

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
