import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, ConfigProvider, Effect, Exit, Logger } from "effect";
import { SqlError } from "effect/sql";

import { runtimeRoleConfig } from "@node-effect/config";

import { reportMigrationFailure } from "../migrate.ts";

const sentinels =
  /SECRET_SENTINEL|SQL_SENTINEL|PARAM_SENTINEL|ROLLBACK_SENTINEL/;

const connectionLost = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.ConnectionError({
      cause: Object.assign(new Error(message), { code: "57P01" }),
      message,
    }),
  });

// What drizzle fails with when a migration statement fails.
const failedStatement = () =>
  new EffectDrizzleQueryError({
    query: 'CREATE TABLE "SQL_SENTINEL" ()',
    params: ["PARAM_SENTINEL"],
    cause: Cause.fail(connectionLost("SECRET_SENTINEL")),
  });

// Runs `program` through the migration reporter and returns its exit and log
// lines.
const runMigration = <E>(program: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];

    const logger = Logger.map(Logger.formatJson, (line) => {
      lines.push(line);
    });

    const exit = yield* program.pipe(
      Effect.tapCause(reportMigrationFailure),
      Effect.provide(Logger.layer([logger])),
      Effect.exit,
    );

    return { exit, output: lines.join("\n"), lineCount: lines.length };
  });

describe("migration failure reporting", () => {
  it.effect("logs a failed statement by its tag and diagnostics", () =>
    Effect.gen(function* () {
      const error = failedStatement();

      const { exit, output, lineCount } = yield* runMigration(
        Effect.fail(error),
      );

      assert(Exit.isFailure(exit));
      assert.strictEqual(Cause.squash(exit.cause), error);
      assert.strictEqual(lineCount, 1);
      assert.match(output, /Database migration failed/);
      assert.match(output, /EffectDrizzleQueryError/);
      assert.match(output, /ConnectionError/);
      assert.match(output, /57P01/);
      assert.notMatch(output, sentinels);
    }),
  );

  it.effect(
    "redacts a failed statement that a dying rollback turns into a defect",
    () =>
      Effect.gen(function* () {
        const error = failedStatement();

        // Like drizzle's migration transaction when the connection is lost:
        // its ROLLBACK dies, and Effect reports the statement's failure as a
        // defect too.
        const { exit, output, lineCount } = yield* runMigration(
          Effect.fail(error).pipe(
            Effect.onExit(() =>
              Effect.die(connectionLost("ROLLBACK_SENTINEL")),
            ),
          ),
        );

        assert(Exit.isFailure(exit));
        assert.lengthOf(exit.cause.reasons, 2);
        assert.isTrue(exit.cause.reasons.every(Cause.isDieReason));
        assert.strictEqual(Cause.squash(exit.cause), error);
        assert.strictEqual(lineCount, 1);
        assert.match(output, /EffectDrizzleQueryError/);
        assert.match(output, /ConnectionError/);
        assert.notMatch(output, sentinels);
      }),
  );

  it.effect("keeps the details of a failure that is not a database's", () =>
    Effect.gen(function* () {
      // How `migrate` fails without its configuration: the operator must see
      // which variable is missing.
      const missingConfiguration = runtimeRoleConfig.parse(
        ConfigProvider.fromEnv({ env: {} }),
      );

      const { output } = yield* runMigration(
        Effect.asVoid(missingConfiguration),
      );

      assert.match(output, /APP_DATABASE_USER/);
    }),
  );

  it.effect("stays quiet on interruption", () =>
    Effect.gen(function* () {
      const { lineCount } = yield* runMigration(Effect.interrupt);

      assert.strictEqual(lineCount, 0);
    }),
  );
});

// migrate.ts is where its layers, the migration reporter, LoggingLive and
// runMain's settings meet, and only the process shows how they combine, so
// these run it as one. Neither needs PostgreSQL.
const migratePath = fileURLToPath(new URL("../migrate.ts", import.meta.url));

// Port 1 refuses connections at once; the password must never reach the log.
const unreachableDatabaseUrl =
  "postgresql://app:SECRET_SENTINEL@127.0.0.1:1/app";

// Runs migrate.ts with only `env`, so neither the shell nor .env changes the
// result.
const runMigrate = (env: Record<string, string>) => {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [migratePath],
    { env, encoding: "utf8" },
  );

  const lines = stdout
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

  return { status, stdout, stderr, lines };
};

describe("migrate.ts as a process", () => {
  it("reports missing role settings once, naming them, and exits 1", () => {
    const { status, stderr, lines } = runMigrate({
      DATABASE_URL: unreachableDatabaseUrl,
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr, "");

    assert.deepStrictEqual(
      lines.map((line) => [line.message, line.level]),
      [["Database migration failed", "ERROR"]],
    );

    assert.include(lines[0]?.cause, "APP_DATABASE_USER");
  });

  it("reports a database it cannot reach by its tag and diagnostics, and exits 1", () => {
    const { status, stdout, stderr, lines } = runMigrate({
      DATABASE_URL: unreachableDatabaseUrl,
      APP_DATABASE_USER: "app_runtime",
      APP_DATABASE_PASSWORD: "PASSWORD_SENTINEL",
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr, "");

    assert.deepStrictEqual(
      lines.map((line) => [line.message, line.level]),
      [["Database migration failed", "ERROR"]],
    );

    assert.include(lines[0]?.cause, "SqlError");
    assert.include(lines[0]?.cause, "ConnectionError");
    assert.notMatch(stdout, /SECRET_SENTINEL|PASSWORD_SENTINEL/);
  });
});
