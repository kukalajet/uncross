import { assert, describe, it } from "@effect/vitest";
import { Config, Duration, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import {
  DatabaseHealth,
  DatabaseHealthError,
  UserRepository,
  UserPersistenceFailure,
} from "@uncross/application";

import { DatabaseHealthLive } from "../../database-health-live.ts";
import {
  databaseCallTimeout,
  DatabaseLive,
  PgClientLive,
} from "../../postgres.ts";
import { testAppConfig } from "../../test/app-config.fixtures.ts";
import { pausableProxy } from "../../test/pausable-proxy.ts";
import { UserRepositoryLive } from "../user-repository-live.ts";

const statementTimeoutMs = 1000;

// The call limit with that statement timeout: 5 + 1 + 2 seconds.
const callLimitMs = Duration.toMillis(databaseCallTimeout(statementTimeoutMs));

// DatabaseHealthLive's own limit.
const healthLimitMs = 5000;

// PgClientLive's connect timeout.
const connectLimitMs = 5000;

// Interrupted, @effect/sql-pg sends a CancelRequest on a new connection and
// waits up to 5 seconds for the server to finish the query before it drops the
// connection. A paused server does neither, so a call on an open connection
// fails this long after its limit.
const cancelWaitMs = 5000;

// For timers and round trips.
const slackMs = 1000;

const pausedTestTimeoutMs = 30_000;

type BackendPid = { readonly pid: number };

// UserRepositoryLive and DatabaseHealthLive on a pool that reaches PostgreSQL
// through `proxyPort`.
const repositoryThrough = (databaseUrl: URL, proxyPort: number) => {
  const proxiedUrl = new URL(databaseUrl);

  proxiedUrl.hostname = "127.0.0.1";
  proxiedUrl.port = String(proxyPort);

  const config = testAppConfig({
    databaseUrl: Redacted.make(proxiedUrl.toString()),
    databaseStatementTimeoutMs: statementTimeoutMs,
  });

  return Layer.mergeAll(UserRepositoryLive, DatabaseHealthLive).pipe(
    Layer.provideMerge(DatabaseLive),
    Layer.provideMerge(PgClientLive),
    Layer.provideMerge(config),
  );
};

describe("UserRepositoryLive on a paused PostgreSQL", () => {
  it.live(
    "fails each call within its limit plus the driver's cancel wait",
    () =>
      Effect.gen(function* () {
        const databaseUrl = new URL(yield* Config.String("DATABASE_URL"));

        const proxy = yield* pausableProxy({
          host: databaseUrl.hostname,
          port: Number(databaseUrl.port || "5432"),
        });

        yield* Effect.gen(function* () {
          const repository = yield* UserRepository;
          const health = yield* DatabaseHealth;
          const sql = yield* SqlClient.SqlClient;

          // Two overlapping queries leave two open connections in the pool,
          // one for each call below.
          const sessions = yield* Effect.all(
            [
              sql<BackendPid>`select pg_backend_pid() as pid from pg_sleep(0.2)`,
              sql<BackendPid>`select pg_backend_pid() as pid from pg_sleep(0.2)`,
            ],
            { concurrency: 2 },
          );

          assert.strictEqual(
            new Set(sessions.map(([session]) => session?.pid)).size,
            2,
          );

          yield* proxy.pause;

          const [[listTook, listFailure], [healthTook, healthFailure]] =
            yield* Effect.all(
              [
                repository.list(10).pipe(Effect.flip, Effect.timed),
                health.check.pipe(Effect.flip, Effect.timed),
              ],
              { concurrency: 2 },
            );

          // The driver dropped both connections, so this call waits for a new
          // one and fails when connecting gives up.
          const [nextTook, nextFailure] = yield* repository
            .list(10)
            .pipe(Effect.flip, Effect.timed);

          assert.instanceOf(listFailure, UserPersistenceFailure);

          assert.deepStrictEqual(listFailure.diagnostics, {
            reason: "TimeoutError",
          });

          assert.isAtLeast(Duration.toMillis(listTook), callLimitMs);

          assert.isBelow(
            Duration.toMillis(listTook),
            callLimitMs + cancelWaitMs + slackMs,
          );

          assert.instanceOf(healthFailure, DatabaseHealthError);

          assert.deepStrictEqual(healthFailure.diagnostics, {
            reason: "TimeoutError",
          });

          assert.isAtLeast(Duration.toMillis(healthTook), healthLimitMs);

          assert.isBelow(
            Duration.toMillis(healthTook),
            healthLimitMs + cancelWaitMs + slackMs,
          );

          assert.instanceOf(nextFailure, UserPersistenceFailure);

          assert.deepStrictEqual(nextFailure.diagnostics, {
            reason: "ConnectionError",
          });

          assert.isBelow(Duration.toMillis(nextTook), connectLimitMs + slackMs);
        }).pipe(Effect.provide(repositoryThrough(databaseUrl, proxy.port)));
      }),
    pausedTestTimeoutMs,
  );
});
