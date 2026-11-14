import { assert, describe, it } from "@effect/vitest";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Fiber, Schema } from "effect";
import { SqlError } from "effect/sql";
import { TestClock } from "effect/testing";

import { persistenceFailureFields } from "@node-effect/application";

import { databaseCalls } from "../database-call.ts";

// A persistence failure of the test's own, so the test does not depend on the
// users example.
class ProbeFailure extends Schema.TaggedError<ProbeFailure>()(
  "ProbeFailure",
  persistenceFailureFields(["read", "write"]),
) {}

const calls = databaseCalls(ProbeFailure, "1 second");

const authorizationError = new SqlError.SqlError({
  reason: new SqlError.AuthorizationError({
    cause: Object.assign(new Error("permission denied"), { code: "42501" }),
  }),
});

// What a query fails with when PostgreSQL reports a unique violation: Drizzle
// wraps the driver's SqlError in a cause of its own.
const uniqueViolation = (constraint: string) =>
  new EffectDrizzleQueryError({
    query: "insert into probe_items",
    params: [],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.UniqueViolation({
          cause: new Error("duplicate key"),
          constraint,
        }),
      }),
    ),
  });

// Domain errors the tests map outcomes to.
const labelTaken = { _tag: "LabelTaken" } as const;
const codeTaken = { _tag: "CodeTaken" } as const;
const notFound = { _tag: "NotFound" } as const;

const LabelRow = Schema.Struct({ label: Schema.String });
const firstRow = { label: "first" };
const secondRow = { label: "second" };

describe("databaseCalls", () => {
  it.effect("fails as the operation's failure with safe diagnostics", () =>
    Effect.gen(function* () {
      const failure = yield* calls
        .run("read", Effect.fail(authorizationError))
        .pipe(Effect.flip);

      assert.instanceOf(failure, ProbeFailure);
      assert.strictEqual(failure.operation, "read");
      assert.strictEqual(failure.cause, authorizationError);

      assert.deepStrictEqual(failure.diagnostics, {
        reason: "AuthorizationError",
        code: "42501",
      });
    }),
  );

  it.effect(
    "turns a unique violation on a mapped constraint into its domain error",
    () =>
      Effect.gen(function* () {
        const onUniqueViolation = {
          probe_items_label_key: () => labelTaken,
          probe_items_code_key: () => codeTaken,
        };

        const byLabel = yield* calls
          .run("write", Effect.fail(uniqueViolation("probe_items_label_key")), {
            onUniqueViolation,
          })
          .pipe(Effect.flip);

        const byCode = yield* calls
          .run("write", Effect.fail(uniqueViolation("probe_items_code_key")), {
            onUniqueViolation,
          })
          .pipe(Effect.flip);

        assert.strictEqual(byLabel, labelTaken);
        assert.strictEqual(byCode, codeTaken);
      }),
  );

  it.effect(
    "keeps a unique violation on any other constraint a persistence failure",
    () =>
      Effect.gen(function* () {
        const failure = yield* calls
          .run("write", Effect.fail(uniqueViolation("probe_items_pkey")), {
            onUniqueViolation: { probe_items_label_key: () => labelTaken },
          })
          .pipe(Effect.flip);

        assert.instanceOf(failure, ProbeFailure);
        assert.strictEqual(failure.operation, "write");

        assert.deepStrictEqual(failure.diagnostics, {
          reason: "UniqueViolation",
        });
      }),
  );

  it.effect("fails a call that outlives its timeout as a TimeoutError", () =>
    Effect.gen(function* () {
      const fiber = yield* calls
        .run("read", Effect.never)
        .pipe(Effect.flip, Effect.forkScoped);

      yield* TestClock.adjust("999 millis");
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");
      const failure = yield* Fiber.join(fiber);

      assert.instanceOf(failure, ProbeFailure);
      assert.strictEqual(failure.operation, "read");
      assert.deepStrictEqual(failure.diagnostics, { reason: "TimeoutError" });
    }),
  );

  it.effect("one decodes the single row it expects", () =>
    Effect.gen(function* () {
      const row = yield* calls.one(
        "write",
        Effect.succeed([firstRow]),
        LabelRow,
      );

      assert.deepStrictEqual(row, firstRow);
    }),
  );

  it.effect("one reports a missing row as a persistence failure", () =>
    Effect.gen(function* () {
      const failure = yield* calls
        .one("write", Effect.succeed([]), LabelRow)
        .pipe(Effect.flip);

      assert.instanceOf(failure, ProbeFailure);

      assert.deepStrictEqual(failure.diagnostics, {
        reason: "SchemaError",
        validationPaths: ["0"],
      });
    }),
  );

  it.effect("one reports a missing row as onMissing's domain error", () =>
    Effect.gen(function* () {
      const error = yield* calls
        .one("read", Effect.succeed([]), LabelRow, {
          onMissing: () => notFound,
        })
        .pipe(Effect.flip);

      assert.strictEqual(error, notFound);
    }),
  );

  it.effect("one reports more than one row as a persistence failure", () =>
    Effect.gen(function* () {
      const failure = yield* calls
        .one("read", Effect.succeed([firstRow, secondRow]), LabelRow, {
          onMissing: () => notFound,
        })
        .pipe(Effect.flip);

      assert.instanceOf(failure, ProbeFailure);

      assert.deepStrictEqual(failure.diagnostics, {
        reason: "SchemaError",
        validationPaths: ["1"],
      });
    }),
  );

  it.effect("many decodes every row with the row schema", () =>
    Effect.gen(function* () {
      const rows = yield* calls.many(
        "read",
        Effect.succeed([firstRow, secondRow]),
        LabelRow,
      );

      assert.deepStrictEqual(rows, [firstRow, secondRow]);
    }),
  );

  it.effect(
    "reports rows that do not decode as a persistence failure, never a domain error",
    () =>
      Effect.gen(function* () {
        const failure = yield* calls
          .one("write", Effect.succeed([{}]), LabelRow, {
            onUniqueViolation: { probe_items_label_key: () => labelTaken },
            onMissing: () => notFound,
          })
          .pipe(Effect.flip);

        assert.instanceOf(failure, ProbeFailure);
        assert.strictEqual(failure.operation, "write");

        assert.deepStrictEqual(failure.diagnostics, {
          reason: "SchemaError",
          validationPaths: ["0.label"],
        });
      }),
  );
});
