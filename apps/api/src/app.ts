import { Effect, Layer } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiSwagger } from "effect/http-api";

import { Api } from "./api-contract.ts";
import { InternalErrorResponse, NotFoundResponse } from "./api-schemas.ts";
import { HealthHandlers } from "./health/routes.ts";
import { UserHandlers } from "./users/routes.ts";

// The server answers two errors by itself, outside any contract and without a
// body: 404 for a request that matches no route, and 500 for a handler that
// dies. These are the same responses in the public error envelope.
const serverErrorResponses = [NotFoundResponse, InternalErrorResponse].map(
  ({ status, body }) => HttpServerResponse.jsonUnsafe(body, { status }),
);

// A 404 or a 500 that has no body, in the envelope; any other response as it
// is.
const inEnvelope = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.body._tag !== "Empty") return response;

  return (
    serverErrorResponses.find(({ status }) => status === response.status) ??
    response
  );
};

// Runs for every request, matched or not, and replaces only what is sent: the
// request still fails with its cause, which the access log reads.
const ServerErrorEnvelope = HttpRouter.middleware(
  HttpEffect.withPreResponseHandler((_request, response) =>
    Effect.succeed(inEnvelope(response)),
  ),
  { global: true },
);

const ApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Layer.mergeAll(HealthHandlers, UserHandlers)),
  ),
  HttpApiSwagger.layer(Api, { path: "/docs" }),
  ServerErrorEnvelope,
);

export { ApiRoutes };
