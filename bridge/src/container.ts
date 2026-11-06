// The composition root: the one place that knows how the bridge's services are
// built and how long each one lives. Services take their collaborators as
// constructor arguments; only this module, createApp and server.ts call resolve().
import { join } from "node:path";
import type { Logger } from "pino";
import { container as root, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import type { Config } from "./config.js";
import { LinearEvents } from "./linearEvents.js";
import { LinearOAuth } from "./linearOAuth.js";
import { OAuthController } from "./oauthController.js";
import { SeenDeliveries } from "./seenDeliveries.js";
import { TokenStore } from "./tokenStore.js";
import { CLOCK, CONFIG, FETCH, LOGGER, WEBHOOK_HANDLER } from "./tokens.js";
import { WebhookController } from "./webhookController.js";
import { WebhookQueue } from "./webhookQueue.js";

export function buildContainer(config: Config, logger: Logger): DependencyContainer {
  // A child per app, so two apps (or two tests) never share a singleton. Nothing
  // registers on the global container.
  const c = root.createChildContainer();

  c.registerInstance(CONFIG, config);
  c.registerInstance(LOGGER, logger);
  // Tests replace these three, before anything resolves them.
  c.registerInstance(CLOCK, Date.now);
  c.registerInstance(FETCH, fetch);
  c.register(WEBHOOK_HANDLER, { useToken: LinearEvents });

  // Existing classes keep their options objects, so a factory adapts them.
  // instanceCachingFactory makes each one a singleton of this container; the
  // factories are created here, per container, so the cache is too.
  c.register(LinearOAuth, {
    useFactory: instanceCachingFactory(
      (dc) =>
        new LinearOAuth({
          clientId: config.linear.clientId,
          clientSecret: config.linear.clientSecret,
          redirectUri: `${config.linear.publicUrl}/oauth/callback`,
          fetch: dc.resolve(FETCH),
        }),
    ),
  });
  // Singleton: its refresh de-duplication and its revoke guard only work if every
  // caller shares the one instance.
  c.register(TokenStore, {
    useFactory: instanceCachingFactory(
      (dc) =>
        new TokenStore({
          file: join(config.dataDir, "linear", "tokens.json"),
          oauth: dc.resolve(LinearOAuth),
          logger: dc.resolve(LOGGER),
          now: dc.resolve(CLOCK),
        }),
    ),
  });

  // Singletons: OAuthController's install states must be the same at
  // /oauth/install and /oauth/callback. WebhookController holds the webhook client.
  c.registerSingleton(OAuthController);
  c.registerSingleton(WebhookController);
  // Singletons: one record of seen deliveries, and one queue so events stay in order.
  c.registerSingleton(SeenDeliveries);
  c.registerSingleton(WebhookQueue);
  c.registerSingleton(LinearEvents);

  return c;
}
