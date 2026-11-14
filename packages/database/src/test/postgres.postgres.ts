import { assert, describe, it } from "@effect/vitest";
import { sql } from "drizzle-orm";
import { Config, Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { diagnosticsFromCause } from "../error-diagnostics.ts";
import {
  Database,
  DatabaseLive,
  MigrationPgClientLive,
  PgClientLive,
} from "../postgres.ts";

import { testAppConfig } from "./app-config.fixtures.ts";

// PgClientLive's pool size.
const maxConnections = 10;

// The pool test waits out PgClientLive's 5 second acquire timeout.
const acquireTestTimeoutMs = 20_000;

// The test database, with `databaseStatementTimeoutMs` as the statement
// timeout.
const appConfigWith = (databaseStatementTimeoutMs: number) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const databaseUrl = yield* Config.Redacted("DATABASE_URL");

      return testAppConfig({ databaseUrl, databaseStatementTimeoutMs });
    }),
  );

type SessionLimits = {
  readonly statement_timeout: string;
  readonly lock_timeout: string;
  readonly idle_in_transaction_session_timeout: string;
};

const sessionLimits = SqlClient.SqlClient.use(
  (client) => client<SessionLimits>`
    select
      current_setting('statement_timeout') as statement_timeout,
      current_setting('lock_timeout') as lock_timeout,
      current_setting('idle_in_transaction_session_timeout')
        as idle_in_transaction_session_timeout
  `,
);

describe("PgClientLive", () => {
  it.live("limits statements, lock waits and idle transactions", () =>
    Effect.gen(function* () {
      const limits = yield* sessionLimits;

      assert.deepStrictEqual(limits, [
        {
          statement_timeout: "2500ms",
          lock_timeout: "8s",
          idle_in_transaction_session_timeout: "30s",
        },
      ]);
    }).pipe(
      Effect.provide(PgClientLive.pipe(Layer.provide(appConfigWith(2500)))),
    ),
  );

  it.live(
    "cancels a statement past the statement timeout with SQLSTATE 57014",
    () =>
      Effect.gen(function* () {
        const database = yield* Database;

        const error = yield* database
          .execute(sql`select pg_sleep(5)`)
          .pipe(Effect.flip);

        assert.deepStrictEqual(diagnosticsFromCause(error), {
          reason: "StatementTimeoutError",
          code: "57014",
        });

        // The pool keeps serving after a cancelled statement.
        yield* database.execute(sql`select 1`);
      }).pipe(
        Effect.provide(
          DatabaseLive.pipe(
            Layer.provide(PgClientLive),
            Layer.provide(appConfigWith(100)),
          ),
        ),
      ),
  );

  it.live(
    "fails a query that waits 5 seconds for a pooled connection",
    () =>
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        let holding = 0;

        // Every pooled connection, reserved by an open transaction.
        const holders = yield* Effect.forEach(
          Array.from({ length: maxConnections }),
          () =>
            client
              .withTransaction(
                Effect.gen(function* () {
                  holding += 1;

                  if (holding === maxConnections) {
                    yield* Deferred.succeed(held, undefined);
                  }

                  yield* Deferred.await(release);
                }),
              )
              .pipe(Effect.forkChild),
        );

        yield* Deferred.await(held);

        const [waited, error] = yield* client`select 1`.pipe(
          Effect.flip,
          Effect.timed,
        );

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.joinAll(holders);

        assert.deepStrictEqual(diagnosticsFromCause(error), {
          reason: "ConnectionError",
        });

        assert.isAtLeast(Duration.toMillis(waited), 4500);
        assert.isBelow(Duration.toMillis(waited), 10_000);
      }).pipe(
        Effect.provide(PgClientLive.pipe(Layer.provide(appConfigWith(10_000)))),
      ),
    acquireTestTimeoutMs,
  );
});

describe("MigrationPgClientLive", () => {
  it.live("waits without limit for statements, 5 seconds for a lock", () =>
    Effect.gen(function* () {
      const limits = yield* sessionLimits;

      assert.deepStrictEqual(limits, [
        {
          statement_timeout: "0",
          lock_timeout: "5s",
          idle_in_transaction_session_timeout: "0",
        },
      ]);
    }).pipe(
      Effect.provide(
        MigrationPgClientLive.pipe(Layer.provide(appConfigWith(2500))),
      ),
    ),
  );
});
