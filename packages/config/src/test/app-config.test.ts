import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";

import { AppConfig, appConfig } from "@uncross/config";

const environment = (env: Record<string, string>) =>
  ConfigProvider.fromEnv({ env });

describe("appConfig", () => {
  it.effect("fails when DATABASE_URL is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(appConfig.parse(environment({})));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("applies the database, API and worker defaults", () =>
    Effect.gen(function* () {
      const config = yield* appConfig.parse(
        environment({ DATABASE_URL: "postgres://test" }),
      );

      assert.strictEqual(config.databaseStatementTimeoutMs, 10_000);
      assert.strictEqual(config.apiHost, "127.0.0.1");
      assert.strictEqual(config.apiPort, 8000);
      assert.strictEqual(config.workerPollIntervalMs, 5000);
      assert.strictEqual(config.workerPassTimeoutMs, 60_000);
    }),
  );

  it.effect("reads overrides from the environment", () =>
    Effect.gen(function* () {
      const config = yield* appConfig.parse(
        environment({
          DATABASE_URL: "postgres://test",
          DATABASE_STATEMENT_TIMEOUT_MS: "2500",
          API_HOST: "0.0.0.0",
          API_PORT: "9000",
          WORKER_POLL_INTERVAL_MS: "1500",
          WORKER_PASS_TIMEOUT_MS: "30000",
        }),
      );

      assert.strictEqual(config.databaseStatementTimeoutMs, 2500);
      assert.strictEqual(config.apiHost, "0.0.0.0");
      assert.strictEqual(config.apiPort, 9000);
      assert.strictEqual(config.workerPollIntervalMs, 1500);
      assert.strictEqual(config.workerPassTimeoutMs, 30_000);
    }),
  );

  for (const variable of [
    "DATABASE_STATEMENT_TIMEOUT_MS",
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_PASS_TIMEOUT_MS",
  ]) {
    for (const value of ["0", "-1", "1.5", "Infinity", "invalid"]) {
      it.effect(`rejects ${variable} ${value}`, () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            appConfig.parse(
              environment({
                DATABASE_URL: "postgres://test",
                [variable]: value,
              }),
            ),
          );

          assert.isTrue(Exit.isFailure(exit));
        }),
      );
    }
  }

  it.effect("accepts PostgreSQL's largest statement timeout", () =>
    Effect.gen(function* () {
      const config = yield* appConfig.parse(
        environment({
          DATABASE_URL: "postgres://test",
          DATABASE_STATEMENT_TIMEOUT_MS: "2147483647",
        }),
      );

      assert.strictEqual(config.databaseStatementTimeoutMs, 2_147_483_647);
    }),
  );

  it.effect("rejects a statement timeout PostgreSQL would refuse", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        appConfig.parse(
          environment({
            DATABASE_URL: "postgres://test",
            DATABASE_STATEMENT_TIMEOUT_MS: "2147483648",
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  for (const value of ["0", "65536", "http"]) {
    it.effect(`rejects API port ${value}`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          appConfig.parse(
            environment({ DATABASE_URL: "postgres://test", API_PORT: value }),
          ),
        );

        assert.isTrue(Exit.isFailure(exit));
      }),
    );
  }
});

describe("AppConfig.layer", () => {
  it.effect("reads the active ConfigProvider and keeps the URL redacted", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;

      assert.strictEqual(
        Redacted.value(config.databaseUrl),
        "postgres://secret@test",
      );

      assert.strictEqual(String(config.databaseUrl), "<redacted>");
      assert.notInclude(JSON.stringify(config), "secret");
    }).pipe(
      Effect.provide(
        AppConfig.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              environment({ DATABASE_URL: "postgres://secret@test" }),
            ),
          ),
        ),
      ),
    ),
  );
});
