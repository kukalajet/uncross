import { Effect, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { CreateUserSchema, UserId, UserSchema } from "@node-effect/domain";

import { RequestValidation } from "../api-middleware.ts";
import {
  DatabaseErrorResponse,
  PayloadTooLargeResponse,
  publicError,
  UnsupportedMediaTypeResponse,
} from "../api-schemas.ts";
import { withJsonBodyLimit } from "../request-body.ts";

const UserParams = Schema.Struct({ id: UserId });

// A valid body is under 2 KiB: a 320-character email and a 100-character
// display name at up to 4 UTF-8 bytes per character, plus the JSON around them.
const createUserBodyMaxBytes = 4 * 1024;

// The list has no cursor, so `limit` caps what one request can read. A project
// that needs to page past the cap adds its own pagination.
const UserListQuery = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(50)),
  ),
});

const UserListResponse = Schema.Struct({ users: Schema.Array(UserSchema) });

const UserNotFoundResponse = publicError(
  404,
  "USER_NOT_FOUND",
  "User not found",
);

const UserAlreadyExistsResponse = publicError(
  409,
  "USER_ALREADY_EXISTS",
  "A user with this email already exists",
);

const UsersApi = HttpApiGroup.make("users")
  .add(
    // The OpenAPI document describes a query parameter by its string encoding,
    // so the description states the range and default.
    HttpApiEndpoint.get("list", "/users", {
      query: UserListQuery,
      success: UserListResponse,
      error: DatabaseErrorResponse.schema,
    }).annotate(
      OpenApi.Description,
      "Lists users, newest first. `limit` is an integer from 1 to 100 and defaults to 50.",
    ),
    HttpApiEndpoint.get("get", "/users/:id", {
      params: UserParams,
      success: UserSchema,
      error: [UserNotFoundResponse.schema, DatabaseErrorResponse.schema],
    }),
    // The handler reads the body itself, at most the bytes withJsonBodyLimit
    // sets below, and decodes it with this payload (see request-body.ts).
    HttpApiEndpoint.post("create", "/users", {
      payload: CreateUserSchema,
      success: UserSchema.pipe(HttpApiSchema.status(201)),
      error: [
        PayloadTooLargeResponse.schema,
        UnsupportedMediaTypeResponse.schema,
        UserAlreadyExistsResponse.schema,
        DatabaseErrorResponse.schema,
      ],
    }).pipe(withJsonBodyLimit(createUserBodyMaxBytes)),
  )
  .middleware(RequestValidation);

export {
  UserAlreadyExistsResponse,
  UserListQuery,
  UserNotFoundResponse,
  UserParams,
  UsersApi,
};
