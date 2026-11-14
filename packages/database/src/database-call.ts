import { type Duration, Effect, Schema } from "effect";

import { AppConfig } from "@uncross/config";

import { diagnosticsFromCause, findSqlError } from "./error-diagnostics.ts";
import { databaseCallTimeout } from "./postgres.ts";

type FailureProps<Operation extends string> = {
  readonly operation: Operation;
  readonly cause: unknown;
  readonly diagnostics: ReturnType<typeof diagnosticsFromCause>;
};

// Which domain error a unique violation on each named constraint means, such
// as UserAlreadyExists for the users table's email constraint.
type UniqueViolations = Readonly<Record<string, () => unknown>>;

type NoUniqueViolations = Readonly<Record<never, never>>;

type MappedError<Map extends UniqueViolations> = ReturnType<Map[keyof Map]>;

type CallOptions<Map extends UniqueViolations> = {
  readonly onUniqueViolation?: Map;
};

type OneOptions<Map extends UniqueViolations, Missing> = CallOptions<Map> & {
  // The domain error a missing row means, such as UserNotFound. Without it, a
  // missing row is a persistence failure.
  readonly onMissing?: () => Missing;
};

// The domain error `onUniqueViolation` names for `cause`, when the cause is a
// unique violation on one of its constraints.
const mappedUniqueViolation = <Map extends UniqueViolations>(
  cause: unknown,
  onUniqueViolation: Map | undefined,
) => {
  const reason = findSqlError(cause)?.reason;
  if (onUniqueViolation === undefined) return undefined;
  if (reason?._tag !== "UniqueViolation") return undefined;

  // Own keys only, so a constraint named like an Object method maps to nothing.
  if (!Object.hasOwn(onUniqueViolation, reason.constraint)) return undefined;

  // SAFETY: the function comes from `onUniqueViolation`, so what it returns is
  // one of the errors MappedError<Map> lists.
  return onUniqueViolation[reason.constraint]?.() as MappedError<Map>;
};

// Drizzle returns the rows of every query as an array.
const isEmptyResult = (result: unknown) =>
  Array.isArray(result) && result.length === 0;

// How an adapter calls the database: every call is bounded by `timeout`, and
// fails as `FailureClass` for its operation with diagnostics read from the
// cause, unless `onUniqueViolation` names the domain error the cause means.
// The timeout is required because PostgreSQL's own limits cannot fire when the
// server stops answering (see databaseCallTimeout); repositories get that
// limit from repositoryCalls, and readiness passes a shorter one of its own.
const databaseCalls = <Operation extends string, Failure>(
  FailureClass: new (props: FailureProps<Operation>) => Failure,
  timeout: Duration.Input,
) => {
  const toFailure = (operation: Operation, cause: unknown) =>
    new FailureClass({
      operation,
      cause,
      diagnostics: diagnosticsFromCause(cause),
    });

  // Decodes a query's result with `schema`, so stored data that is no longer
  // valid fails as a persistence failure for `operation`, never as a domain
  // error.
  const decodeResult = <S extends Schema.Constraint>(
    operation: Operation,
    schema: S,
  ) => {
    const decode = Schema.decodeUnknownEffect(schema);

    return (result: unknown) =>
      decode(result).pipe(
        Effect.mapError((cause) => toFailure(operation, cause)),
      );
  };

  // A query without rows to decode. Every cause but a mapped unique
  // violation, a timeout included, is a persistence failure.
  const run = <A, R, const Map extends UniqueViolations = NoUniqueViolations>(
    operation: Operation,
    query: Effect.Effect<A, unknown, R>,
    options: CallOptions<Map> = {},
  ): Effect.Effect<A, Failure | MappedError<Map>, R> =>
    query.pipe(
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          mappedUniqueViolation(cause, options.onUniqueViolation) ??
          toFailure(operation, cause),
      ),
    );

  // A query that returns exactly one row, decoded with `rowSchema`. No row is a
  // persistence failure unless `onMissing` names the domain error it means;
  // more than one row always is.
  const one = <
    S extends Schema.Constraint,
    R,
    const Map extends UniqueViolations = NoUniqueViolations,
    Missing = never,
  >(
    operation: Operation,
    query: Effect.Effect<unknown, unknown, R>,
    rowSchema: S,
    options: OneOptions<Map, Missing> = {},
  ): Effect.Effect<
    S["Type"],
    Failure | MappedError<Map> | Missing,
    R | S["DecodingServices"]
  > => {
    // SAFETY: a one-element tuple of `rowSchema` decodes to a one-element tuple
    // of its type and needs what `rowSchema` needs; TypeScript cannot reduce
    // the generic tuple schema's types to say so.
    const decodeRow = decodeResult(operation, Schema.Tuple([rowSchema])) as (
      result: unknown,
    ) => Effect.Effect<readonly [S["Type"]], Failure, S["DecodingServices"]>;

    return run(operation, query, options).pipe(
      Effect.flatMap(
        (
          result,
        ): Effect.Effect<
          S["Type"],
          Failure | Missing,
          S["DecodingServices"]
        > => {
          if (options.onMissing !== undefined && isEmptyResult(result)) {
            return Effect.fail(options.onMissing());
          }

          return decodeRow(result).pipe(Effect.map(([row]) => row));
        },
      ),
    );
  };

  // A query that returns any number of rows, each decoded with `rowSchema`.
  const many = <
    S extends Schema.Constraint,
    R,
    const Map extends UniqueViolations = NoUniqueViolations,
  >(
    operation: Operation,
    query: Effect.Effect<unknown, unknown, R>,
    rowSchema: S,
    options: CallOptions<Map> = {},
  ): Effect.Effect<
    ReadonlyArray<S["Type"]>,
    Failure | MappedError<Map>,
    R | S["DecodingServices"]
  > =>
    run(operation, query, options).pipe(
      Effect.flatMap(decodeResult(operation, Schema.Array(rowSchema))),
    );

  return { many, one, run };
};

// How a repository calls the database: `databaseCalls` bounded by the longest
// the configured statement timeout and the pool wait allow, so a feature
// adapter needs neither the configuration nor the limit's formula.
const repositoryCalls = <Operation extends string, Failure>(
  FailureClass: new (props: FailureProps<Operation>) => Failure,
) =>
  AppConfig.pipe(
    Effect.map((config) =>
      databaseCalls(
        FailureClass,
        databaseCallTimeout(config.databaseStatementTimeoutMs),
      ),
    ),
  );

export { databaseCalls, repositoryCalls };
