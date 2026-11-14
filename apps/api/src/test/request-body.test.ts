import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import { RequestValidation } from "../api-middleware.ts";
import {
  BadRequestResponse,
  PayloadTooLargeResponse,
  UnsupportedMediaTypeResponse,
} from "../api-schemas.ts";
import { jsonBodyHandler, withJsonBodyLimit } from "../request-body.ts";

const NoteSchema = Schema.Struct({ text: Schema.String });

// Answers with the body it was given.
const echo = <A>(body: A) => Effect.succeed(body);

// The handler for any endpoint, whatever its payload.
const echoBody = jsonBodyHandler((body: unknown) => echo(body));

// A complete JSON endpoint of the test's own: payload, limit, the 413 and the
// 415 among its errors, behind RequestValidation.
const NotesApi = HttpApi.make("notes").add(
  HttpApiGroup.make("notes")
    .add(
      HttpApiEndpoint.post("create", "/notes", {
        payload: NoteSchema,
        success: NoteSchema,
        error: [
          PayloadTooLargeResponse.schema,
          UnsupportedMediaTypeResponse.schema,
        ],
      }).pipe(withJsonBodyLimit(1024)),
    )
    .middleware(RequestValidation),
);

// The same endpoint, without the 415.
const NotesWithout415Api = HttpApi.make("notes").add(
  HttpApiGroup.make("notes")
    .add(
      HttpApiEndpoint.post("create", "/notes", {
        payload: NoteSchema,
        success: NoteSchema,
        error: PayloadTooLargeResponse.schema,
      }).pipe(withJsonBodyLimit(1024)),
    )
    .middleware(RequestValidation),
);

const jsonHeaders = { "content-type": "application/json" };

// A small, valid JSON body. It is bytes, which get no Content-Type of their
// own as a string would.
const noteBytes = new TextEncoder().encode(JSON.stringify({ text: "hello" }));

// A POST as the router hands it to a raw handler.
const notePost = (headers: Record<string, string>, body: string | Uint8Array) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/notes", { method: "POST", headers, body }),
  );

// Reads a body as `endpoint`'s raw handler does: the one above, sent as JSON,
// unless the test gives its own.
const readBody = (
  endpoint: Parameters<typeof echoBody>[0]["endpoint"],
  headers: Record<string, string> = jsonHeaders,
  body: string | Uint8Array = noteBytes,
) =>
  echoBody({ endpoint }).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      notePost(headers, body),
    ),
    Effect.exit,
  );

// The users route tests read real bodies through the users contract; these
// cover the content types and the text this module accepts, the limit it reads
// from an endpoint, and the contracts that leave out what it needs from them.
describe("jsonBodyHandler", () => {
  it.effect("decodes a body within the endpoint's limit", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
        payload: NoteSchema,
      }).pipe(withJsonBodyLimit(1024));

      const exit = yield* readBody(endpoint);

      assert.deepStrictEqual(exit, Exit.succeed({ text: "hello" }));
    }),
  );

  it.effect("fails with the 413 body for a body over that limit", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
        payload: NoteSchema,
      }).pipe(withJsonBodyLimit(8));

      const exit = yield* readBody(endpoint);

      assert.deepStrictEqual(exit, Exit.fail(PayloadTooLargeResponse.body));
    }),
  );

  for (const contentType of [
    "application/json; charset=utf-8",
    "Application/JSON",
  ]) {
    it.effect(`decodes a body sent as ${contentType}`, () =>
      Effect.gen(function* () {
        const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
          payload: NoteSchema,
        }).pipe(withJsonBodyLimit(1024));

        const exit = yield* readBody(endpoint, { "content-type": contentType });

        assert.deepStrictEqual(exit, Exit.succeed({ text: "hello" }));
      }),
    );
  }

  // The limit of 8 bytes is under the body's 16: a body that is not JSON is
  // refused before it is read.
  for (const { name, headers } of [
    { name: "text/plain", headers: { "content-type": "text/plain" } },
    {
      name: "a parameter that names application/json",
      headers: { "content-type": "text/plain; charset=application/json" },
    },
    { name: "no content type", headers: {} },
  ]) {
    it.effect(`fails with the 415 body for ${name}, without reading`, () =>
      Effect.gen(function* () {
        const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
          payload: NoteSchema,
        }).pipe(withJsonBodyLimit(8));

        const exit = yield* readBody(endpoint, headers);

        assert.deepStrictEqual(
          exit,
          Exit.fail(UnsupportedMediaTypeResponse.body),
        );
      }),
    );
  }

  for (const { name, body } of [
    {
      // Latin-1 writes U+00FF and U+00FE as the bytes 0xff and 0xfe, which
      // UTF-8 never uses.
      name: "bytes that are not UTF-8",
      body: Buffer.from(JSON.stringify({ text: "a\u00ff\u00feb" }), "latin1"),
    },
    {
      // JSON.stringify writes a lone surrogate as its escape, \ud800.
      name: "a lone surrogate written as an escape",
      body: JSON.stringify({ text: "a\ud800b" }),
    },
  ]) {
    it.effect(`fails with the 400 body for ${name}`, () =>
      Effect.gen(function* () {
        const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
          payload: NoteSchema,
        }).pipe(withJsonBodyLimit(1024));

        const exit = yield* readBody(endpoint, jsonHeaders, body);

        assert.deepStrictEqual(exit, Exit.fail(BadRequestResponse.body));
      }),
    );
  }

  it.effect("fails with the 400 body for a lone surrogate in a key", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("createLabels", "/labels", {
        payload: Schema.Record(Schema.String, Schema.String),
      }).pipe(withJsonBodyLimit(1024));

      const exit = yield* readBody(
        endpoint,
        jsonHeaders,
        JSON.stringify({ "\ud800": "label" }),
      );

      assert.deepStrictEqual(exit, Exit.fail(BadRequestResponse.body));
    }),
  );

  it.effect("decodes a surrogate pair written as escapes", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
        payload: NoteSchema,
      }).pipe(withJsonBodyLimit(1024));

      const exit = yield* readBody(
        endpoint,
        jsonHeaders,
        String.raw`{"text":"\ud83d\ude00"}`,
      );

      assert.deepStrictEqual(exit, Exit.succeed({ text: "\u{1f600}" }));
    }),
  );

  it.effect("dies naming an endpoint whose contract sets no limit", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("createNote", "/notes", {
        payload: NoteSchema,
      });

      const exit = yield* readBody(endpoint);

      assert(Exit.isFailure(exit));
      assert.isTrue(exit.cause.reasons.every(Cause.isDieReason));

      assert.match(
        String(Cause.squash(exit.cause)),
        /createNote declares no JsonBodyLimit/,
      );
    }),
  );

  it.effect("dies naming an endpoint that declares no JSON payload", () =>
    Effect.gen(function* () {
      const endpoint = HttpApiEndpoint.post("ping", "/ping").pipe(
        withJsonBodyLimit(1024),
      );

      const exit = yield* readBody(endpoint);

      assert(Exit.isFailure(exit));
      assert.isTrue(exit.cause.reasons.every(Cause.isDieReason));

      assert.match(
        String(Cause.squash(exit.cause)),
        /ping declares no JSON payload/,
      );
    }),
  );

  it("registers with handleRaw, and not with handle", () => {
    const handlers = HttpApiBuilder.group(NotesApi, "notes", (notes) => {
      // @ts-expect-error: handle reads the body first, without the limit
      notes.handle("create", jsonBodyHandler(echo));

      return notes.handleRaw("create", jsonBodyHandler(echo));
    });

    assert.isTrue(Layer.isLayer(handlers));
  });

  it("registers only for an endpoint that declares the 415", () => {
    const handlers = HttpApiBuilder.group(
      NotesWithout415Api,
      "notes",
      (notes) =>
        // Effect's own check reports the undeclared 415 as well, and has a
        // directive of its own.
        // @ts-expect-error: the endpoint cannot answer the handler's 415
        // @effect-diagnostics-next-line missingEffectError:off
        notes.handleRaw("create", jsonBodyHandler(echo)),
    );

    assert.isTrue(Layer.isLayer(handlers));
  });
});
