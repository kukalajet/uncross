import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Redacted } from "effect";

import { runtimeRoleConfig } from "@node-effect/config";

const parse = (env: Record<string, string>) =>
  Effect.exit(runtimeRoleConfig.parse(ConfigProvider.fromEnv({ env })));

describe("runtimeRoleConfig", () => {
  it.effect("reads the role name and keeps the password redacted", () =>
    Effect.gen(function* () {
      const exit = yield* parse({
        APP_DATABASE_USER: "node_effect_app",
        APP_DATABASE_PASSWORD: "SECRET_SENTINEL",
      });

      assert(Exit.isSuccess(exit));
      assert.strictEqual(exit.value.name, "node_effect_app");

      assert.strictEqual(
        Redacted.value(exit.value.password),
        "SECRET_SENTINEL",
      );

      assert.notInclude(JSON.stringify(exit.value), "SECRET_SENTINEL");
    }),
  );

  for (const name of [`_${"a1".repeat(31)}`, "pgadmin_app", "public_app"]) {
    it.effect(`accepts the role name ${name}`, () =>
      Effect.gen(function* () {
        const exit = yield* parse({
          APP_DATABASE_USER: name,
          APP_DATABASE_PASSWORD: "secret",
        });

        assert.isTrue(Exit.isSuccess(exit));
      }),
    );
  }

  for (const name of [
    "",
    "App",
    "1app",
    "app-role",
    "app role",
    'app"; drop table users; --',
    "app';--",
    "app;",
    "app@host",
    "app\n",
    "a".repeat(64),
  ]) {
    it.effect(`rejects the role name ${JSON.stringify(name)}`, () =>
      Effect.gen(function* () {
        const exit = yield* parse({
          APP_DATABASE_USER: name,
          APP_DATABASE_PASSWORD: "secret",
        });

        assert.isTrue(Exit.isFailure(exit));
      }),
    );
  }

  // Valid identifiers that CREATE ROLE rejects. Refusing them here stops
  // `migrate` before it changes anything.
  for (const name of [
    "pg_app",
    "pg_execute_server_program",
    "pg_database_owner",
    "public",
    "none",
  ]) {
    it.effect(`rejects the reserved role name ${name}`, () =>
      Effect.gen(function* () {
        const exit = yield* parse({
          APP_DATABASE_USER: name,
          APP_DATABASE_PASSWORD: "secret",
        });

        assert(Exit.isFailure(exit));
        assert.include(String(exit.cause), "PostgreSQL does not reserve");
      }),
    );
  }

  it.effect("requires both variables and a non-empty password", () =>
    Effect.gen(function* () {
      for (const env of [
        { APP_DATABASE_PASSWORD: "secret" },
        { APP_DATABASE_USER: "app" },
        { APP_DATABASE_USER: "app", APP_DATABASE_PASSWORD: "" },
      ]) {
        const exit = yield* parse(env);

        assert.isTrue(Exit.isFailure(exit));
      }
    }),
  );
});
