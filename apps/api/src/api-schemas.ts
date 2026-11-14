import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

// Every public error has the same envelope. The code and message are literals,
// so the OpenAPI document lists exactly what a client can receive. `schema`
// goes in the endpoint's contract, and `body`, its only value, is what a
// handler fails with, so the code and message are written once. `status` is
// for a response that no contract declares.
const publicError = <const Code extends string, const Message extends string>(
  status: number,
  code: Code,
  message: Message,
) => {
  const schema = Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literal(code),
      message: Schema.Literal(message),
    }),
  }).pipe(HttpApiSchema.status(status));

  return { status, schema, body: schema.make({ error: { code, message } }) };
};

const BadRequestResponse = publicError(
  400,
  "INVALID_REQUEST",
  "The request payload is invalid",
);

const NotFoundResponse = publicError(404, "NOT_FOUND", "Route not found");

const PayloadTooLargeResponse = publicError(
  413,
  "PAYLOAD_TOO_LARGE",
  "The request payload is too large",
);

const UnsupportedMediaTypeResponse = publicError(
  415,
  "UNSUPPORTED_MEDIA_TYPE",
  "The request content type must be application/json",
);

const InternalErrorResponse = publicError(
  500,
  "INTERNAL_ERROR",
  "The request could not be completed",
);

const DatabaseErrorResponse = publicError(
  500,
  "DATABASE_ERROR",
  "The database operation could not be completed",
);

const DatabaseUnavailableResponse = publicError(
  503,
  "DATABASE_UNAVAILABLE",
  "The database is unavailable",
);

export {
  BadRequestResponse,
  DatabaseErrorResponse,
  DatabaseUnavailableResponse,
  InternalErrorResponse,
  NotFoundResponse,
  PayloadTooLargeResponse,
  publicError,
  UnsupportedMediaTypeResponse,
};
