import { assert, onTestFinished } from "@effect/vitest";
import { Effect, Layer, Logger, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  type HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { Api } from "../api-contract.ts";

// The route the router matched for a request: its method and path pattern.
type MatchedRoute = { readonly method: string; readonly path: string };

// Records the route the router matched for each request, keyed by the web
// request, so the contract check finds the endpoint that answered without a
// precedence rule of its own.
const recordMatchedRoutes = (matched: WeakMap<object, MatchedRoute>) =>
  HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const { route } = yield* HttpRouter.RouteContext;
      const request = yield* HttpServerRequest.HttpServerRequest;
      matched.set(request.source, { method: route.method, path: route.path });

      return yield* httpEffect;
    }),
  ).layer;

// The schemas `api` declares for the status of `response` from the endpoint
// at `route`.
const declaredResponseSchemas = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<Id, Groups>,
  route: MatchedRoute | undefined,
  request: Request,
  response: Response,
) => {
  const pathname = new URL(request.url).pathname;
  const declared: Array<ReadonlyArray<Schema.Top>> = [];

  if (route !== undefined) {
    HttpApi.reflect(api, {
      predicate: ({ endpoint }) =>
        endpoint.method === route.method && endpoint.path === route.path,
      onGroup: () => {},
      onEndpoint: ({ successes, errors }) => {
        const byStatus = response.status < 400 ? successes : errors;
        declared.push(byStatus.get(response.status) ?? []);
      },
    });
  }

  const [schemas] = declared;

  assert.isDefined(
    schemas,
    `Undocumented operation: ${request.method} ${pathname}`,
  );

  assert.isNotEmpty(
    schemas,
    `Undocumented response: ${request.method} ${pathname} ${response.status}`,
  );

  return schemas;
};

// A JSON body matches when it is a valid JSON encoding of the schema, which is
// what HttpApi writes; a no-content schema matches an empty body.
const bodyMatches = (schema: Schema.Top, text: string) => {
  if (HttpApiSchema.isNoContent(schema.ast)) return text === "";
  if (text === "") return false;

  const isEncodedBody = Schema.is(Schema.toEncoded(Schema.toCodecJson(schema)));

  return isEncodedBody(JSON.parse(text));
};

// Fails unless the contract documents the matched route and the status, and
// the body matches one of the schemas it declares for that status.
const assertContractResponse = async <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<Id, Groups>,
  route: MatchedRoute | undefined,
  request: Request,
  response: Response,
) => {
  const schemas = declaredResponseSchemas(api, route, request, response);
  const text = await response.clone().text();
  const pathname = new URL(request.url).pathname;

  assert.isTrue(
    schemas.some((schema) => bodyMatches(schema, text)),
    `Response does not match its contract: ${request.method} ${pathname} ${response.status}`,
  );
};

// Serves one group of the API, as a test file states once. `serve(services)`
// provides the services its handlers read per request and returns a server
// whose `fetch` checks every response against the group's contract. The server
// is disposed when the test finishes.
const serveGroup =
  <Group extends HttpApiGroup.Constraint, Services = never>(
    group: Group,
    handlers: Layer.Layer<
      HttpApiGroup.ToService<typeof Api.identifier, Group>,
      never,
      HttpRouter.Request<"Requires", Services>
    >,
  ) =>
  (services: Layer.Layer<Services>) => {
    const api = HttpApi.make(Api.identifier).add(group);
    const matchedRoutes = new WeakMap<object, MatchedRoute>();

    const routes = HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provide(recordMatchedRoutes(matchedRoutes)),
      Layer.provide(HttpServer.layerServices),
      // Handlers log the failures they map; http-errors.test.ts checks those
      // logs.
      Layer.provide(Logger.layer([])),
      HttpRouter.provideRequest(services),
    );

    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    onTestFinished(web.dispose);

    // SAFETY: `services` provides what the handlers require per request, so
    // the handler needs no request context. The generic `Services` hides that
    // from TypeScript, which then asks for one.
    const handler = web.handler as (request: Request) => Promise<Response>;

    return {
      fetch: async (request: Request) => {
        const response = await handler(request);
        const route = matchedRoutes.get(request);
        await assertContractResponse(api, route, request, response);

        return response;
      },
    };
  };

export { serveGroup };
