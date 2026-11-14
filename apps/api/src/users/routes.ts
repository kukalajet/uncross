import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { UserRepository } from "@node-effect/application";
import type { CreateUser } from "@node-effect/domain";

import { Api } from "../api-contract.ts";
import { RequestValidationLive } from "../api-middleware.ts";
import { databaseFailure } from "../http-errors.ts";
import { jsonBodyHandler } from "../request-body.ts";

import {
  UserAlreadyExistsResponse,
  type UserListQuery,
  UserNotFoundResponse,
  type UserParams,
} from "./api-contract.ts";

const listUsers = ({ limit }: typeof UserListQuery.Type) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository;
    const users = yield* repository.list(limit);

    return { users };
  }).pipe(Effect.catchTag("UserPersistenceFailure", databaseFailure));

const getUser = ({ id }: typeof UserParams.Type) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository;

    return yield* repository.findById(id);
  }).pipe(
    Effect.catchTags({
      UserNotFound: () => Effect.fail(UserNotFoundResponse.body),
      UserPersistenceFailure: databaseFailure,
    }),
  );

const createUser = (input: CreateUser) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository;

    return yield* repository.insert(input);
  }).pipe(
    Effect.catchTags({
      UserAlreadyExists: () => Effect.fail(UserAlreadyExistsResponse.body),
      UserPersistenceFailure: databaseFailure,
    }),
  );

const UserHandlers = HttpApiBuilder.group(Api, "users", (handlers) =>
  handlers
    .handle("list", ({ query }) => listUsers(query))
    .handle("get", ({ params }) => getUser(params))
    // Raw, so HttpApi leaves the body for jsonBodyHandler to read within its
    // limit.
    .handleRaw("create", jsonBodyHandler(createUser)),
).pipe(Layer.provide(RequestValidationLive));

export { UserHandlers };
