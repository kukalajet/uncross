import { desc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { UserRepository, UserPersistenceFailure } from "@uncross/application";
import {
  type CreateUser,
  UserAlreadyExists,
  type UserIdType,
  UserNotFound,
} from "@uncross/domain";

import { repositoryCalls } from "../database-call.ts";
import { Database } from "../postgres.ts";

import { userEmailUniqueConstraint, UserRowSchema, users } from "./schema.ts";

const makeUserRepository = Effect.gen(function* () {
  const database = yield* Database;
  const calls = yield* repositoryCalls(UserPersistenceFailure);

  // Only the email constraint means the address is taken; any other unique
  // violation stays a persistence failure.
  const insert = Effect.fn("UserRepository.insert")(function* (
    input: CreateUser,
  ) {
    return yield* calls.one(
      "insert",
      database.insert(users).values(input).returning(),
      UserRowSchema,
      {
        onUniqueViolation: {
          [userEmailUniqueConstraint]: () =>
            new UserAlreadyExists({ email: input.email }),
        },
      },
    );
  });

  const findById = Effect.fn("UserRepository.findById")(function* (
    id: UserIdType,
  ) {
    return yield* calls.one(
      "findById",
      database.select().from(users).where(eq(users.id, id)).limit(1),
      UserRowSchema,
      { onMissing: () => new UserNotFound({ id }) },
    );
  });

  // Users inserted in one transaction share created_at (now() is the
  // transaction's start time). The id breaks those ties, so the order, and
  // which users fall under the limit, stays the same between requests.
  const list = Effect.fn("UserRepository.list")(function* (limit: number) {
    return yield* calls.many(
      "list",
      database
        .select()
        .from(users)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(limit),
      UserRowSchema,
    );
  });

  return UserRepository.of({ insert, findById, list });
});

const UserRepositoryLive = Layer.effect(UserRepository, makeUserRepository);

export { UserRepositoryLive };
