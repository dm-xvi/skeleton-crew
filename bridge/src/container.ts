// The composition root: the one place that knows how the bridge's services are
// built and how long each one lives. Services take their collaborators as
// constructor arguments; only this module, createApp and server.ts call resolve().
import { join } from "node:path";
import type { Logger } from "pino";
import { container as root, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import type { Config } from "./config.js";
import { LinearOAuth } from "./linearOAuth.js";
import { TokenStore } from "./tokenStore.js";
import { CLOCK, CONFIG, FETCH, LOGGER } from "./tokens.js";

export function buildContainer(config: Config, logger: Logger): DependencyContainer {
  // A child per app, so two apps (or two tests) never share a singleton. Nothing
  // registers on the global container.
  const c = root.createChildContainer();

  c.registerInstance(CONFIG, config);
  c.registerInstance(LOGGER, logger);
  // Tests replace these two, before anything resolves them.
  c.registerInstance(CLOCK, Date.now);
  c.registerInstance(FETCH, fetch);

  // Existing classes keep their options objects, so a factory adapts them.
  // instanceCachingFactory makes each one a singleton of this container; the
  // factories are created here, per container, so the cache is too.
  c.register(LinearOAuth, {
    useFactory: instanceCachingFactory(
      (c) =>
        new LinearOAuth({
          clientId: config.linear.clientId,
          clientSecret: config.linear.clientSecret,
          redirectUri: `${config.linear.publicUrl}/oauth/callback`,
          fetch: c.resolve(FETCH),
        }),
    ),
  });
  // Singleton: its refresh de-duplication and its revoke guard only work if every
  // caller shares the one instance.
  c.register(TokenStore, {
    useFactory: instanceCachingFactory(
      (c) =>
        new TokenStore({
          file: join(config.dataDir, "linear", "tokens.json"),
          oauth: c.resolve(LinearOAuth),
          logger: c.resolve(LOGGER),
          now: c.resolve(CLOCK),
        }),
    ),
  });

  return c;
}
