import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { UserRepository, UserPersistenceFailure } from "@uncross/application";
import {
  CreateUserSchema,
  UserAlreadyExists,
  UserId,
  UserNotFound,
} from "@uncross/domain";

import { withMigratedDatabase } from "../../test/migrated-database.fixtures.ts";
import { UserRepositoryLive } from "../user-repository-live.ts";

const withUserDatabase = withMigratedDatabase(UserRepositoryLive);

const ada = Schema.decodeUnknownSync(CreateUserSchema)({
  email: "ada@example.com",
  displayName: "Ada Lovelace",
});

const grace = Schema.decodeUnknownSync(CreateUserSchema)({
  email: "grace@example.com",
  displayName: "Grace Hopper",
});

const unknownId = Schema.decodeUnknownSync(UserId)(
  "70ded4af-dcb4-4148-9e0d-a6bd38192a39",
);

const lowerId = Schema.decodeUnknownSync(UserId)(
  "1f6a54e4-0b52-4c43-9a58-0a3c4c1f3b11",
);

const higherId = Schema.decodeUnknownSync(UserId)(
  "e2c1b1a0-5a8e-4f5c-8d9e-7b6a5c4d3e22",
);

// Every later insert into users fails as a unique violation of `constraint`.
const rejectInsertsAs = (constraint: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.unsafe(
      `create function reject_user() returns trigger language plpgsql as $$
       begin
         raise unique_violation using constraint = '${constraint}';
       end $$`,
    );

    yield* sql.unsafe(
      `create trigger reject_user before insert on users
       for each row execute function reject_user()`,
    );
  });

describe("UserRepositoryLive on PostgreSQL", () => {
  it.live("inserts a user and finds it by id", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      const user = yield* repository.insert(ada);

      assert.strictEqual(user.email, ada.email);
      assert.strictEqual(user.displayName, ada.displayName);
      assert.instanceOf(user.createdAt, Date);
      assert.deepStrictEqual(yield* repository.findById(user.id), user);
    }).pipe(withUserDatabase),
  );

  it.live("lists the newest users first, up to the limit", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`insert into users (email, display_name, created_at)
        values (${ada.email}, ${ada.displayName}, '2026-08-09T12:00:00Z'),
               (${grace.email}, ${grace.displayName}, '2026-08-10T12:00:00Z')`;

      const users = yield* repository.list(10);

      assert.deepStrictEqual(
        users.map((user) => user.email),
        [grace.email, ada.email],
      );

      assert.deepStrictEqual(
        users.map((user) => user.createdAt.toISOString()),
        ["2026-08-10T12:00:00.000Z", "2026-08-09T12:00:00.000Z"],
      );

      assert.deepStrictEqual(yield* repository.list(1), users.slice(0, 1));
    }).pipe(withUserDatabase),
  );

  it.live("orders users created at the same time by id", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;
      const sql = yield* SqlClient.SqlClient;

      // One statement, so both rows get the same created_at from now().
      // Ordered by created_at alone, the backward index scan returns ties
      // last-inserted first, so the higher id goes in first: only the id
      // tiebreak puts it ahead.
      yield* sql`insert into users (id, email, display_name)
        values (${higherId}, ${grace.email}, ${grace.displayName}),
               (${lowerId}, ${ada.email}, ${ada.displayName})`;

      const users = yield* repository.list(10);

      assert.deepStrictEqual(
        users.map((user) => user.id),
        [higherId, lowerId],
      );

      assert.deepStrictEqual(users[0]?.createdAt, users[1]?.createdAt);
      assert.deepStrictEqual(yield* repository.list(1), users.slice(0, 1));
    }).pipe(withUserDatabase),
  );

  it.live("lists no users in an empty table", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      assert.deepStrictEqual(yield* repository.list(10), []);
    }).pipe(withUserDatabase),
  );

  it.live("reports a missing user", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      const error = yield* repository.findById(unknownId).pipe(Effect.flip);

      assert.instanceOf(error, UserNotFound);
      assert.strictEqual(error.id, unknownId);
    }).pipe(withUserDatabase),
  );

  it.live("reports a taken email address", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      yield* repository.insert(ada);

      const error = yield* repository
        .insert({ ...ada, displayName: "Another Ada" })
        .pipe(Effect.flip);

      assert.instanceOf(error, UserAlreadyExists);
      assert.strictEqual(error.email, ada.email);
    }).pipe(withUserDatabase),
  );

  it.live("reports another unique violation as a persistence failure", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;

      yield* rejectInsertsAs("another_constraint");
      const error = yield* repository.insert(ada).pipe(Effect.flip);

      assert.instanceOf(error, UserPersistenceFailure);
      assert.strictEqual(error.operation, "insert");

      assert.deepStrictEqual(error.diagnostics, {
        reason: "UniqueViolation",
        code: "23505",
      });
    }).pipe(withUserDatabase),
  );

  it.live("reports a stored row that breaks the domain rules", () =>
    Effect.gen(function* () {
      const repository = yield* UserRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`insert into users (id, email, display_name)
        values (${unknownId}, 'not-an-email', 'Ada Lovelace')`;

      const error = yield* repository.findById(unknownId).pipe(Effect.flip);

      assert.instanceOf(error, UserPersistenceFailure);

      assert.deepStrictEqual(error.diagnostics, {
        reason: "SchemaError",
        validationPaths: ["0.email"],
      });
    }).pipe(withUserDatabase),
  );
});
