import { ConfigProvider, type Context, Effect, Layer } from "effect";

import { AppConfig, appConfig } from "@uncross/config";

// AppConfig with `appConfig`'s defaults, overridden by `overrides`, and a
// database URL that adapter unit tests never connect to. It never reads the
// process environment, so `.env` changes no test.
const testAppConfig = (
  overrides: Partial<Context.Service.Shape<typeof AppConfig>> = {},
) =>
  Layer.effect(
    AppConfig,
    Effect.map(appConfig, (defaults) =>
      AppConfig.of({ ...defaults, ...overrides }),
    ),
  ).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { DATABASE_URL: "postgresql://unused" },
        }),
      ),
    ),
  );

export { testAppConfig };
