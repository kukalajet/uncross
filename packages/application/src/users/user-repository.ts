import { Context, Effect, Schema } from "effect";

import {
  type CreateUser,
  type User,
  UserAlreadyExists,
  type UserIdType,
  UserNotFound,
} from "@uncross/domain";

import { persistenceFailureFields } from "../persistence-failure.ts";

const repositoryOperations = ["insert", "findById", "list"] as const;

class UserPersistenceFailure extends Schema.TaggedError<UserPersistenceFailure>()(
  "UserPersistenceFailure",
  persistenceFailureFields(repositoryOperations),
) {}

class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly insert: (
      input: CreateUser,
    ) => Effect.Effect<User, UserAlreadyExists | UserPersistenceFailure>;
    readonly findById: (
      id: UserIdType,
    ) => Effect.Effect<User, UserNotFound | UserPersistenceFailure>;
    // At most `limit` users, newest first.
    readonly list: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<User>, UserPersistenceFailure>;
  }
>()("@uncross/application/UserRepository") {}

export { UserRepository, UserPersistenceFailure };
