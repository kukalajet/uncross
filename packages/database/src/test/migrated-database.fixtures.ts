import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Config, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import type { AppConfig } from "@node-effect/config";

import {
  type Database,
  DatabaseLive,
  MigrationPgClientLive,
  PgClientLive,
} from "../postgres.ts";

import { testAppConfig } from "./app-config.fixtures.ts";

const migrationsRoot = join(import.meta.dirname, "../../../../drizzle");

// Every statement in drizzle/, in the order drizzle-kit applies them: by
// migration folder, whose names start with a timestamp.
const readMigrationStatements = () =>
  readdirSync(migrationsRoot)
    .sort()
    .map((folder) => join(migrationsRoot, folder, "migration.sql"))
    .filter((path) => existsSync(path))
    .flatMap((path) =>
      readFileSync(path, "utf8").split("--> statement-breakpoint"),
    )
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const migrationStatements = readMigrationStatements();

// Connections opened with the returned URL resolve unqualified names in
// `schemaName` only.
const withSearchPath = (databaseUrl: string, schemaName: string) => {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options") ?? "";

  url.searchParams.set(
    "options",
    `${options} -c search_path=${schemaName}`.trim(),
  );

  return url.toString();
};

// Creates the schema with `statements` applied, and drops it with everything
// in it when the layer is released.
const testSchema = (schemaName: string, statements: ReadonlyArray<string>) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.unsafe(`create schema "${schemaName}"`);

        for (const statement of statements) {
          yield* sql.unsafe(statement);
        }

        return sql;
      }),
      (sql) =>
        sql.unsafe(`drop schema "${schemaName}" cascade`).pipe(Effect.orDie),
    ),
  );

// A schema of its own for one test, on `pgClient`. Provides `Database`, the
// `SqlClient` it runs on, so a test can arrange and inspect rows directly, and
// the `AppConfig` both read.
const testDatabase = (
  statements: ReadonlyArray<string>,
  pgClient: typeof PgClientLive,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const databaseUrl = yield* Config.String("DATABASE_URL");
      const schemaName = `test_${crypto.randomUUID().replaceAll("-", "")}`;

      const config = testAppConfig({
        databaseUrl: Redacted.make(withSearchPath(databaseUrl, schemaName)),
      });

      return Layer.mergeAll(
        DatabaseLive,
        testSchema(schemaName, statements),
      ).pipe(Layer.provideMerge(pgClient), Layer.provideMerge(config));
    }),
  );

// Runs an effect on a fresh schema with every migration applied, providing
// `adapter` built on it.
const withMigratedDatabase = <Provided, LayerError>(
  adapter: Layer.Layer<Provided, LayerError, AppConfig | Database>,
) =>
  Effect.provide(
    adapter.pipe(
      Layer.provideMerge(testDatabase(migrationStatements, PgClientLive)),
    ),
  );

// Runs an effect on a fresh schema with nothing in it, on the client
// `migrate.ts` uses.
const withEmptyDatabase = Effect.provide(
  testDatabase([], MigrationPgClientLive),
);

export { withEmptyDatabase, withMigratedDatabase };
