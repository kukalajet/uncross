import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema } from "effect";
import { SqlError } from "effect/sql";
import { TestClock } from "effect/testing";

import {
  UserRepository,
  UserPersistenceFailure,
} from "@node-effect/application";
import { UserAlreadyExists, UserNotFound } from "@node-effect/domain";

import { DatabaseLive } from "../../postgres.ts";
import { testAppConfig } from "../../test/app-config.fixtures.ts";
import {
  connectionFailingWith,
  connectionWithRows,
  pgClientLayer,
  stalledConnection,
} from "../../test/pg-client.ts";
import { UserRepositoryLive } from "../user-repository-live.ts";

const repositoryWithRows = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
  UserRepositoryLive.pipe(
    Layer.provide(DatabaseLive),
    Layer.provide(pgClientLayer(Effect.succeed(connectionWithRows(rows)))),
    Layer.provide(testAppConfig()),
  );

// A database that accepts every query and never answers it, like a server that
// stopped responding: none of PostgreSQL's own limits fires. With a 1 second
// statement timeout, the call limit is the 5 second pool wait, plus that
// second, plus the 2 second margin.
const stalledRepository = UserRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(pgClientLayer(Effect.succeed(stalledConnection))),
  Layer.provide(testAppConfig({ databaseStatementTimeoutMs: 1000 })),
);

const stalledCallLimitMs = 8000;

// A database that fails every query as PostgreSQL does when an insert breaks
// the unique constraint named `constraint`.
const repositoryViolating = (constraint: string) =>
  UserRepositoryLive.pipe(
    Layer.provide(DatabaseLive),
    Layer.provide(
      pgClientLayer(
        Effect.succeed(
          connectionFailingWith(
            new SqlError.SqlError({
              reason: new SqlError.UniqueViolation({
                cause: new Error("duplicate key value"),
                constraint,
              }),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(testAppConfig()),
  );

const user = {
  id: "d5b9d3de-fda5-4a78-b8a5-2f3b60634d95",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  createdAt: new Date("2026-08-09T12:00:00.000Z"),
};

const input = { email: user.email, displayName: user.displayName };

const storedRow = [
  user.id,
  "  ada@example.com  ",
  "  Ada Lovelace  ",
  user.createdAt.toISOString(),
];

const invalidRows = [
  {
    field: "email",
    path: "email",
    row: [
      user.id,
      "not-an-email",
      user.displayName,
      user.createdAt.toISOString(),
    ],
  },
  {
    field: "display name",
    path: "displayName",
    row: [user.id, user.email, "   ", user.createdAt.toISOString()],
  },
];

const runOperation = (operation: "insert" | "findById" | "list") =>
  Effect.gen(function* () {
    const repository = yield* UserRepository;

    switch (operation) {
      case "insert":
        return [yield* repository.insert(input)];
      case "findById":
        return [yield* repository.findById(user.id)];
      case "list":
        return yield* repository.list(10);
    }
  });

describe("UserRepositoryLive", () => {
  for (const operation of ["insert", "findById", "list"] as const) {
    it.effect(`${operation} decodes and normalizes persisted rows`, () =>
      Effect.gen(function* () {
        const result = yield* runOperation(operation);

        assert.deepStrictEqual(result, [user]);
      }).pipe(Effect.provide(repositoryWithRows([storedRow]))),
    );

    for (const { field, path, row } of invalidRows) {
      it.effect(`${operation} rejects an invalid persisted ${field}`, () =>
        Effect.gen(function* () {
          const failure = yield* runOperation(operation).pipe(Effect.flip);

          assert.instanceOf(failure, UserPersistenceFailure);
          assert.strictEqual(failure.operation, operation);
          assert.isTrue(Schema.isSchemaError(failure.cause));

          assert.deepStrictEqual(failure.diagnostics, {
            reason: "SchemaError",
            validationPaths: [`${operation === "list" ? 1 : 0}.${path}`],
          });
        }).pipe(
          Effect.provide(
            repositoryWithRows(operation === "list" ? [storedRow, row] : [row]),
          ),
        ),
      );
    }
  }

  it.effect("findById reports a missing row as UserNotFound", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;
      const failure = yield* repository.findById(user.id).pipe(Effect.flip);

      assert.instanceOf(failure, UserNotFound);
      assert.strictEqual(failure.id, user.id);
    }).pipe(Effect.provide(repositoryWithRows([]))),
  );

  it.effect("insert reports a taken email as UserAlreadyExists", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;
      const failure = yield* repository.insert(input).pipe(Effect.flip);

      assert.instanceOf(failure, UserAlreadyExists);
      assert.strictEqual(failure.email, input.email);
    }).pipe(Effect.provide(repositoryViolating("users_email_key"))),
  );

  it.effect(
    "insert reports another unique violation as a persistence failure",
    () =>
      Effect.gen(function* () {
        const repository = yield* UserRepository;
        const failure = yield* repository.insert(input).pipe(Effect.flip);

        assert.instanceOf(failure, UserPersistenceFailure);
        assert.strictEqual(failure.operation, "insert");

        assert.deepStrictEqual(failure.diagnostics, {
          reason: "UniqueViolation",
        });
      }).pipe(Effect.provide(repositoryViolating("users_pkey"))),
  );

  for (const operation of ["insert", "findById", "list"] as const) {
    it.effect(`${operation} gives up on a database that stops answering`, () =>
      Effect.gen(function* () {
        const fiber = yield* runOperation(operation).pipe(
          Effect.flip,
          Effect.forkScoped,
        );

        yield* TestClock.adjust(stalledCallLimitMs - 1);
        assert.isUndefined(fiber.pollUnsafe());

        yield* TestClock.adjust(1);
        const failure = yield* Fiber.join(fiber);

        assert.instanceOf(failure, UserPersistenceFailure);
        assert.strictEqual(failure.operation, operation);
        assert.deepStrictEqual(failure.diagnostics, { reason: "TimeoutError" });
      }).pipe(Effect.provide(stalledRepository)),
    );
  }

  it.effect("list returns an empty result unchanged", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      assert.deepStrictEqual(yield* repository.list(10), []);
    }).pipe(Effect.provide(repositoryWithRows([]))),
  );
});
