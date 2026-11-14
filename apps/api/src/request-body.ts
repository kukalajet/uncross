import { Context, Effect, Option, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import type { HttpApiEndpoint } from "effect/http-api";

import {
  BadRequestResponse,
  PayloadTooLargeResponse,
  UnsupportedMediaTypeResponse,
} from "./api-schemas.ts";

// The most bytes an endpoint's JSON body may have. `withJsonBodyLimit` sets it
// on the endpoint's contract, and `jsonBody` reads it from there.
class JsonBodyLimit extends Context.Service<JsonBodyLimit, number>()(
  "@node-effect/api/JsonBodyLimit",
) {}

// What jsonBody reads from an endpoint: its payloads and their types, its
// identifier and its annotations.
type BodyEndpoint = HttpApiEndpoint.ConstraintRequest & {
  readonly payload: HttpApiEndpoint.PayloadMap;
  readonly annotations: Context.Context<never>;
};

// The schema of the JSON payload an endpoint's contract declares.
type JsonPayload<Endpoint> =
  HttpApiEndpoint.Payload<Endpoint> extends infer S extends Schema.Top
    ? S
    : never;

// A Content-Type's media type ends where its parameters begin, such as
// "; charset=utf-8", and is not case-sensitive (RFC 9110, section 8.3.1).
const isJsonContentType = (contentType: string | undefined) =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

// A page on another site can make a browser post text/plain, or a body with no
// content type, without a CORS preflight, and application/json only with one.
// Refusing the rest, before reading the body, keeps such a page from posting
// JSON with a user's cookies.
const requireJsonContentType = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (!isJsonContentType(request.headers["content-type"])) {
    return yield* Effect.fail(UnsupportedMediaTypeResponse.body);
  }
});

type CollectedBody = {
  readonly chunks: Array<Uint8Array>;
  readonly byteLength: number;
};

// Stops reading as soon as the body passes `maxBytes`, whatever the
// Content-Length header claims.
const collectBody = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    return yield* request.stream.pipe(
      Stream.runFoldEffect(
        (): CollectedBody => ({ chunks: [], byteLength: 0 }),
        (body, chunk) => {
          const byteLength = body.byteLength + chunk.byteLength;
          if (byteLength > maxBytes) {
            return Effect.fail(PayloadTooLargeResponse.body);
          }

          body.chunks.push(chunk);

          return Effect.succeed({ chunks: body.chunks, byteLength });
        },
      ),
    );
  });

const joinBodyChunks = (body: CollectedBody): Uint8Array => {
  const bytes = new Uint8Array(body.byteLength);
  let offset = 0;

  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

// Text that is not valid Unicode would be stored as U+FFFD, the replacement
// character, so its body is refused: here rather than in each payload schema,
// so that every string of every endpoint is covered. `fatal` makes bytes that
// are not UTF-8 fail to decode.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.try({
    try: () => textDecoder.decode(bytes),
    catch: () => BadRequestResponse.body,
  });

// A JSON.parse reviver. Valid UTF-8 can still spell a lone surrogate as an
// escape, such as "\ud800", in a string or in a key. Throwing makes the body
// invalid JSON.
const requireWellFormedStrings = (key: string, value: unknown) => {
  const isWellFormed =
    key.isWellFormed() && (typeof value !== "string" || value.isWellFormed());

  if (!isWellFormed) {
    throw new SyntaxError("A JSON string has a lone surrogate");
  }

  return value;
};

// The JSON payload's schema among the payloads `endpoint` declares.
const jsonPayloadSchema = (endpoint: BodyEndpoint) => {
  for (const payload of endpoint.payload.values()) {
    if (payload.encoding._tag === "Json" && "schemas" in payload) {
      return payload.schemas[0];
    }
  }

  return undefined;
};

// Reads `endpoint`'s JSON body, which the request must send as
// application/json: at most the limit `withJsonBodyLimit` set on its contract,
// decoded with the payload schema the contract declares, unknown fields and
// text that is not valid Unicode rejected. Fails with the public 400, 413 or
// 415 body. A contract without a JSON payload or a limit is a mistake in the
// code, so reading its body dies, naming the endpoint.
const jsonBody = <Endpoint extends BodyEndpoint>(endpoint: Endpoint) => {
  const schema = jsonPayloadSchema(endpoint);
  const maxBytes = Context.getOption(endpoint.annotations, JsonBodyLimit);

  if (schema === undefined) {
    return Effect.die(
      new Error(`Endpoint ${endpoint.identifier} declares no JSON payload`),
    );
  }

  if (Option.isNone(maxBytes)) {
    return Effect.die(
      new Error(`Endpoint ${endpoint.identifier} declares no JsonBodyLimit`),
    );
  }

  const decodeBody = Schema.decodeUnknownEffect(
    Schema.fromJsonString(schema, { reviver: requireWellFormedStrings }),
    { onExcessProperty: "error" },
  );

  // SAFETY: `schema` is the JSON payload `endpoint` declares, so it decodes to
  // that payload's type and needs its decoding services; the endpoint's
  // payload map only forgets which schema it holds.
  return requireJsonContentType.pipe(
    Effect.andThen(collectBody(maxBytes.value)),
    Effect.map(joinBodyChunks),
    Effect.flatMap(decodeUtf8),
    Effect.flatMap(decodeBody),
    Effect.catchTags({
      HttpServerError: () => Effect.fail(BadRequestResponse.body),
      SchemaError: () => Effect.fail(BadRequestResponse.body),
    }),
  ) as Effect.Effect<
    JsonPayload<Endpoint>["Type"],
    | typeof BadRequestResponse.body
    | typeof PayloadTooLargeResponse.body
    | typeof UnsupportedMediaTypeResponse.body,
    | HttpServerRequest.HttpServerRequest
    | JsonPayload<Endpoint>["DecodingServices"]
  >;
};

// What a raw handler receives for an endpoint with a JSON body. `handle` passes
// a decoded `payload`, which this type refuses.
type RawBodyRequest = {
  readonly endpoint: BodyEndpoint;
  readonly payload?: never;
};

// The handler of an endpoint with a JSON body: reads the body with `jsonBody`
// and passes it to `handler`, with the raw handler's request for its params,
// query and headers. It fails with the public 400, 413 or 415 body, so the
// endpoint must declare PayloadTooLargeResponse and
// UnsupportedMediaTypeResponse and sit behind RequestValidation, and leaving
// any of them out does not compile. Neither does registering it with `handle`
// instead of `handleRaw`: HttpApi would read the body first, without the
// limit.
const jsonBodyHandler =
  <Request extends RawBodyRequest, A, E, R>(
    handler: (
      body: JsonPayload<Request["endpoint"]>["Type"],
      request: Request,
    ) => Effect.Effect<A, E, R>,
  ) =>
  (request: Request) =>
    jsonBody<Request["endpoint"]>(request.endpoint).pipe(
      Effect.flatMap((body) => handler(body, request)),
    );

// Sets the body limit on a JSON endpoint's contract: `maxBytes` is what
// `jsonBodyHandler` reads there, beside the PayloadTooLargeResponse and
// UnsupportedMediaTypeResponse the endpoint must declare.
const withJsonBodyLimit =
  (maxBytes: number) =>
  <
    Endpoint extends {
      readonly annotate: (key: typeof JsonBodyLimit, value: number) => Endpoint;
    },
  >(
    endpoint: Endpoint,
  ) =>
    endpoint.annotate(JsonBodyLimit, maxBytes);

export { jsonBodyHandler, withJsonBodyLimit };
