import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Duration, Effect, Layer } from "effect";

import { AppConfig } from "@uncross/config";

const applicationName = "uncross";
const connectTimeout = "5 seconds";

// With every pooled connection busy, a query waits this long for one and then
// fails like any other database operation, instead of queueing without bound
// behind slow statements. It matches the wait for a new connection, and the
// pool counts opening one as part of it.
const acquireTimeoutMs = 5_000;

// The previous release keeps serving while `migrate` runs. An ALTER TABLE
// waiting for its ACCESS EXCLUSIVE lock, behind a long transaction say, holds
// up every later query on that table, so the migration gives up after this
// wait. The release then fails before it changes anything (see
// deploy/vps/bin/release) and can run again once that transaction ends.
const migrationLockTimeoutMs = 5_000;

// Longer than the migration's lock wait, so a query queued behind a migration
// that gives up still succeeds. Shorter than the default statement timeout, so
// a query stuck behind a lock fails with SQLSTATE 55P03 (lock timeout) rather
// than 57014 (statement timeout), which reads as slow SQL.
const lockTimeoutMs = 8_000;

// PostgreSQL ends a session that stays idle inside an open transaction this
// long. The statements of one transaction here follow each other within
// milliseconds, so only a transaction a fiber abandoned gets this far, and
// ending it releases the locks that would block migrations and vacuum. Its
// connection is gone with it, so the transaction's ROLLBACK fails too and the
// transaction dies with a defect rather than a persistence failure: the worker
// logs it and restarts, and the API answers 500 without DATABASE_ERROR.
const idleInTransactionSessionTimeoutMs = 30_000;

// PostgreSQL enforces the limits above, so none of them fires when the server
// stops answering, and a query on an open connection would wait as long as its
// caller. Repositories therefore bound each call themselves, by the longest the
// server's limits allow: the wait for a connection, then the statement, plus a
// margin for the round trip, so the server's own error arrives first whenever
// it can. Interrupted, the driver cancels the query and waits up to 5 seconds
// for the server to confirm before it drops the connection and the call fails.
const callMarginMs = 2_000;

const databaseCallTimeout = (statementTimeoutMs: number) =>
  Duration.millis(acquireTimeoutMs + statementTimeoutMs + callMarginMs);

const PgClientLive = PgClient.layerFrom(
  Effect.gen(function* () {
    const config = yield* AppConfig;

    // The pool opens connections on demand, so liveness does not depend on the
    // database being available during application startup.
    return yield* PgClient.make({
      url: config.databaseUrl,
      applicationName,
      connectTimeout,
      acquireTimeout: Duration.millis(acquireTimeoutMs),
      maxConnections: 10,
      minConnections: 0,
      startupParameters: {
        statement_timeout: String(config.databaseStatementTimeoutMs),
        lock_timeout: String(lockTimeoutMs),
        idle_in_transaction_session_timeout: String(
          idleInTransactionSessionTimeoutMs,
        ),
      },
    });
  }),
);

// The client `migrate.ts` runs on. The migrator runs one statement at a time,
// so one connection is enough. Building an index on a large table can take
// minutes, so statements have no time limit; setting it to 0 also overrides a
// default set on the role or the database.
const MigrationPgClientLive = PgClient.layerFrom(
  Effect.gen(function* () {
    const config = yield* AppConfig;

    return yield* PgClient.make({
      url: config.databaseUrl,
      applicationName: `${applicationName}-migrate`,
      connectTimeout,
      maxConnections: 1,
      minConnections: 0,
      startupParameters: {
        statement_timeout: "0",
        lock_timeout: String(migrationLockTimeoutMs),
      },
    });
  }),
);

const databaseEffect = PgDrizzle.makeWithDefaults();

class Database extends Context.Service<
  Database,
  Effect.Success<typeof databaseEffect>
>()("@uncross/database/Database") {}

type DatabaseTransaction = Parameters<
  Parameters<Database["Service"]["transaction"]>[0]
>[0];

const DatabaseLive = Layer.effect(Database, databaseEffect);

export {
  Database,
  databaseCallTimeout,
  DatabaseLive,
  type DatabaseTransaction,
  MigrationPgClientLive,
  PgClientLive,
};
