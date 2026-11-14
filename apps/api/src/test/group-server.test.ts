import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { Api } from "../api-contract.ts";

import { serveGroup } from "./group-server.fixtures.ts";

const Answered = (endpoint: string) =>
  Schema.Struct({ endpoint: Schema.Literal(endpoint) });

// A group of the test's own, so these tests do not depend on a feature's
// routes. `first` and `second` both have one path parameter and match
// GET /a/b/c; the router prefers the literal `a`, so `second` answers although
// `first` comes first. `teapot` and `mismatch` answer raw, outside what the
// contract declares.
const ProbeGroup = HttpApiGroup.make("probes").add(
  HttpApiEndpoint.get("first", "/:y/b/c", { success: Answered("first") }),
  HttpApiEndpoint.get("second", "/a/:x/c", { success: Answered("second") }),
  HttpApiEndpoint.get("teapot", "/teapot", { success: Answered("teapot") }),
  HttpApiEndpoint.get("mismatch", "/mismatch", {
    success: Answered("mismatch"),
  }),
);

const ProbeHandlers = HttpApiBuilder.group(
  HttpApi.make(Api.identifier).add(ProbeGroup),
  "probes",
  (handlers) =>
    handlers
      .handle("first", () => Effect.succeed({ endpoint: "first" as const }))
      .handle("second", () => Effect.succeed({ endpoint: "second" as const }))
      .handleRaw("teapot", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 418 })),
      )
      .handleRaw("mismatch", () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ endpoint: "other" })),
      ),
);

const serve = serveGroup(ProbeGroup, ProbeHandlers);

const get = (path: string) => new Request(`http://localhost${path}`);

// The message the server's `fetch` fails with for `request`.
const failureOf = async (request: Request) => {
  const failure: unknown = await serve(Layer.empty)
    .fetch(request)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  assert.instanceOf(failure, Error);

  return failure.message;
};

describe("serveGroup", () => {
  it("checks a response against the endpoint the router chose", async () => {
    const server = serve(Layer.empty);
    const response = await server.fetch(get("/a/b/c"));

    assert.deepStrictEqual(await response.json(), { endpoint: "second" });
  });

  it("fails a status the contract does not declare", async () => {
    assert.include(
      await failureOf(get("/teapot")),
      "Undocumented response: GET /teapot 418",
    );
  });

  it("fails a body that matches no declared schema", async () => {
    assert.include(
      await failureOf(get("/mismatch")),
      "Response does not match its contract: GET /mismatch 200",
    );
  });

  it("fails a request that no route matches", async () => {
    assert.include(
      await failureOf(get("/nowhere")),
      "Undocumented operation: GET /nowhere",
    );
  });
});
