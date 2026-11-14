import { PgClient } from "@effect/sql-pg";
import { Effect, Stream } from "effect";
import { SqlClient, type SqlConnection, type SqlError } from "effect/sql";

// A PgClient whose queries go to `acquirer` instead of PostgreSQL, so adapter
// tests exercise the real Drizzle queries, row decoding, and error mapping.
const pgClientLayer = (
  acquirer: SqlConnection.Acquirer,
  transactionAcquirer: SqlConnection.Acquirer = acquirer,
) => {
  const unexpectedOperation = Effect.die(
    new Error("Unexpected PostgreSQL operation"),
  );

  return PgClient.layerFrom(
    SqlClient.make({
      driver: "pg",
      acquirer,
      transactionAcquirer,
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    }).pipe(
      Effect.map((client) =>
        Object.assign(client, {
          [PgClient.TypeId]: PgClient.TypeId,
          config: {},
          json: (): never => {
            throw new Error("Unexpected PostgreSQL JSON fragment");
          },
          listen: () => unexpectedOperation,
          notify: () => unexpectedOperation,
        } satisfies Omit<PgClient.PgClient, keyof SqlClient.SqlClient>),
      ),
    ),
  );
};

// A connection that answers every query with `rows`, as PostgreSQL returns
// them in array mode.
const connectionWithRows = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): SqlConnection.Connection => {
  const unexpectedQuery = Effect.die(
    new Error("Unexpected SQL execution mode"),
  );

  return {
    execute: () => unexpectedQuery,
    executeRaw: () => unexpectedQuery,
    executeStream: () => Stream.fromEffect(unexpectedQuery),
    executeValues: () => Effect.succeed(rows),
    executeValuesUnprepared: () => unexpectedQuery,
    executeUnprepared: () => unexpectedQuery,
  };
};

// A connection that fails every query with `error`, as the driver reports it;
// Drizzle then wraps it as it wraps a real one.
const connectionFailingWith = (
  error: SqlError.SqlError,
): SqlConnection.Connection => {
  const unexpectedQuery = Effect.die(
    new Error("Unexpected SQL execution mode"),
  );

  return {
    execute: () => unexpectedQuery,
    executeRaw: () => unexpectedQuery,
    executeStream: () => Stream.fromEffect(unexpectedQuery),
    executeValues: () => Effect.fail(error),
    executeValuesUnprepared: () => unexpectedQuery,
    executeUnprepared: () => unexpectedQuery,
  };
};

// A connection that accepts every query and never answers it.
const stalledConnection: SqlConnection.Connection = {
  execute: () => Effect.never,
  executeRaw: () => Effect.never,
  executeStream: () => Stream.fromEffect(Effect.never),
  executeValues: () => Effect.never,
  executeValuesUnprepared: () => Effect.never,
  executeUnprepared: () => Effect.never,
};

export {
  connectionFailingWith,
  connectionWithRows,
  pgClientLayer,
  stalledConnection,
};
