import { join } from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect, Layer } from "effect";
import { SqlError } from "effect/sql";

import { reportFailure } from "@node-effect/application";
import { AppConfig, LoggingLive, runtimeRoleConfig } from "@node-effect/config";

import { diagnosticsFromCause } from "./error-diagnostics.ts";
import { Database, DatabaseLive, MigrationPgClientLive } from "./postgres.ts";
import { checkRuntimeRole, provisionRuntimeRole } from "./runtime-role.ts";

const migrationsFolder = join(import.meta.dirname, "../../../drizzle");

// drizzle-kit's default journal location; drizzle.config.ts keeps it, so
// `drizzle-kit migrate` and this program each skip what the other applied.
const drizzleKitMigrationsSchema = "drizzle";
const migrationsTable = "__drizzle_migrations";

// Applies every migration in drizzle/ that the journal does not list yet, in
// one transaction.
const migrateDatabase = (migrationsSchema = drizzleKitMigrationsSchema) =>
  Database.use((database) =>
    migrate(database, { migrationsFolder, migrationsSchema, migrationsTable }),
  );

const isDatabaseFailure = (
  error: unknown,
): error is EffectDrizzleQueryError | SqlError.SqlError =>
  error instanceof EffectDrizzleQueryError || SqlError.isSqlError(error);

const databaseFailureReport = (
  error: EffectDrizzleQueryError | SqlError.SqlError,
) => ({ _tag: error._tag, diagnostics: diagnosticsFromCause(error) });

// Database causes can carry SQL and stored values, so they are reported by
// their safe diagnostics, also when one arrives as a defect: a migration whose
// connection drops fails its statement and then dies on ROLLBACK. Other
// failures, such as missing configuration, keep their details.
const reportMigrationFailure = reportFailure("Database migration failed", {
  isSensitive: isDatabaseFailure,
  report: databaseFailureReport,
});

const MigrationDatabaseLive = DatabaseLive.pipe(
  Layer.provideMerge(MigrationPgClientLive),
  Layer.provide(AppConfig.layer),
);

// The runtime role's settings are read, and the role checked, before anything
// changes, so a missing password or a role that is not safe to provision fails
// the run untouched. Its grants follow the migrations' commit in a transaction
// of their own: drizzle's migrator owns its transaction, and the grants must
// see the tables it created. Should they fail, the migrations stay applied,
// which a release tolerates anyway because the running version must work with
// them, and the next run grants again.
const migration = Effect.gen(function* () {
  const runtimeRole = yield* runtimeRoleConfig;

  yield* checkRuntimeRole(runtimeRole);
  yield* migrateDatabase();
  yield* Effect.logInfo("Database migrations applied");
  yield* provisionRuntimeRole(runtimeRole);

  yield* Effect.logInfo("Database runtime role provisioned").pipe(
    Effect.annotateLogs({ role: runtimeRole.name }),
  );
}).pipe(
  Effect.provide(MigrationDatabaseLive),
  Effect.tapCause(reportMigrationFailure),
  Effect.provide(LoggingLive),
);

if (import.meta.main) {
  NodeRuntime.runMain(migration, { disableErrorReporting: true });
}

export { migrateDatabase, reportMigrationFailure };
