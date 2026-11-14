import { assert, describe, it } from "@effect/vitest";
import { Console, ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { TestConsole } from "effect/testing";

import { persistenceFailureFields } from "@node-effect/application";
import { LoggingLive } from "@node-effect/config";

import { accessLog } from "../access-log.ts";

const sentinels = /SECRET_SENTINEL|SQL_SENTINEL|PARAM_SENTINEL/;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

// A persistence failure of the test's own, so the test does not depend on the
// users example.
class ProbeFailure extends Schema.TaggedError<ProbeFailure>()(
  "ProbeFailure",
  persistenceFailureFields(["read", "write"]),
) {}

const repositoryFailure = new ProbeFailure({
  operation: "read",
  cause: Object.assign(new Error("SECRET_SENTINEL"), {
    query: "select SQL_SENTINEL",
    params: ["PARAM_SENTINEL"],
  }),
  diagnostics: { reason: "QueryError", code: "57014" },
});

const Routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/ok",
    Effect.logInfo("handled").pipe(Effect.as(HttpServerResponse.empty())),
  ),
  HttpRouter.add(
    "GET",
    "/slow",
    Effect.sleep("50 millis").pipe(Effect.as(HttpServerResponse.empty())),
  ),
  HttpRouter.add("GET", "/missing", HttpServerResponse.empty({ status: 404 })),
  HttpRouter.add("GET", "/health", HttpServerResponse.empty({ status: 200 })),
  HttpRouter.add("GET", "/health/live", HttpServerResponse.empty()),
  HttpRouter.add(
    "GET",
    "/health/ready",
    HttpServerResponse.empty({ status: 503 }),
  ),
  HttpRouter.add("GET", "/failure", Effect.fail(repositoryFailure)),
  HttpRouter.add("GET", "/defect", Effect.die(repositoryFailure)),
  HttpRouter.add("GET", "/bug", Effect.die(new Error("UNEXPECTED_DEFECT"))),
);

// Serves Routes behind the access log, logging with LoggingLive at its
// default level to a TestConsole, and returns the JSON lines.
const linesFor = (requests: ReadonlyArray<Request>) =>
  Effect.gen(function* () {
    const testConsole = yield* TestConsole.make;

    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(
        Routes,
        LoggingLive.pipe(
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          ),
        ),
        Layer.succeed(Console.Console, testConsole),
      ),
      { disableLogger: true, middleware: accessLog },
    );

    for (const request of requests) {
      yield* Effect.promise(() => web.handler(request));
    }

    yield* Effect.promise(web.dispose);
    const lines = yield* testConsole.logLines;

    return lines.map((line) => JSON.parse(String(line)));
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers });

const post = (path: string) =>
  new Request(`http://localhost${path}`, { method: "POST" });

describe("accessLog", () => {
  it.effect(
    "logs a request once, in the handler's trace, without its query",
    () =>
      Effect.gen(function* () {
        const [handled, access] = yield* linesFor([
          get("/ok?token=SECRET", { "user-agent": "AGENT_SENTINEL" }),
        ]);

        assert.strictEqual(handled.message, "handled");
        assert.strictEqual(access.message, "Sent HTTP response");
        assert.strictEqual(access.level, "INFO");
        assert.isUndefined(access.cause);

        // No client address, user agent or other header, which identify the
        // client and can carry credentials.
        assert.deepStrictEqual(Object.keys(access.annotations), [
          "method",
          "path",
          "status",
          "durationMs",
        ]);

        assert.strictEqual(access.annotations.method, "GET");
        assert.strictEqual(access.annotations.path, "/ok");
        assert.strictEqual(access.annotations.status, 204);
        assert.isNumber(access.annotations.durationMs);
        assert.match(access.traceId, traceIdPattern);
        assert.match(access.spanId, spanIdPattern);
        assert.strictEqual(handled.traceId, access.traceId);
        assert.strictEqual(handled.spanId, access.spanId);
        assert.notInclude(JSON.stringify([handled, access]), "SECRET");
        assert.notInclude(JSON.stringify([handled, access]), "AGENT_SENTINEL");
      }),
  );

  it.effect("gives each request a trace of its own", () =>
    Effect.gen(function* () {
      const [first, second] = yield* linesFor([
        get("/missing"),
        get("/missing"),
      ]);

      assert.notStrictEqual(first.traceId, second.traceId);
    }),
  );

  it.effect("logs a client error at Info without its cause", () =>
    Effect.gen(function* () {
      const lines = yield* linesFor([
        get("/missing"),
        get("/nope?token=SECRET"),
        get("/nope#token=SECRET"),
      ]);

      assert.deepStrictEqual(
        lines.map((line) => [
          line.level,
          line.annotations.path,
          line.annotations.status,
          line.cause,
        ]),
        [
          ["INFO", "/missing", 404, undefined],
          ["INFO", "/nope", 404, undefined],
          ["INFO", "/nope", 404, undefined],
        ],
      );

      assert.notInclude(JSON.stringify(lines), "SECRET");
    }),
  );

  it.effect("measures the time until the response is sent", () =>
    Effect.gen(function* () {
      const [line] = yield* linesFor([get("/slow")]);

      // The route sleeps 50 ms on the real clock, which can fire a little
      // early.
      assert.isAtLeast(line.annotations.durationMs, 40);
    }),
  );

  it.effect("skips passing health probes but logs a failing one", () =>
    Effect.gen(function* () {
      const lines = yield* linesFor([
        get("/health"),
        get("/health/live?probe=compose"),
        get("/health/live#probe"),
        get("/health/ready"),
        post("/health/live"),
        get("/health/other"),
      ]);

      assert.deepStrictEqual(
        lines.map((line) => [
          line.level,
          line.annotations.path,
          line.annotations.status,
        ]),
        [
          ["ERROR", "/health/ready", 503],
          ["INFO", "/health/live", 404],
          ["INFO", "/health/other", 404],
        ],
      );
    }),
  );

  it.effect("logs a persistence failure's safe report, not its cause", () =>
    Effect.gen(function* () {
      const lines = yield* linesFor([get("/failure"), get("/defect")]);

      assert.lengthOf(lines, 2);

      for (const line of lines) {
        assert.strictEqual(line.level, "ERROR");
        assert.strictEqual(line.annotations.status, 500);
        assert.include(line.cause, '"_tag":"ProbeFailure"');
        assert.include(line.cause, '"operation":"read"');
        assert.include(line.cause, '"code":"57014"');
        assert.notInclude(line.cause, "HttpServerResponse");
      }

      assert.notMatch(JSON.stringify(lines), sentinels);
    }),
  );

  it.effect("keeps an unexpected defect's details", () =>
    Effect.gen(function* () {
      const [line] = yield* linesFor([get("/bug")]);

      assert.strictEqual(line.level, "ERROR");
      assert.strictEqual(line.annotations.status, 500);
      assert.include(line.cause, "UNEXPECTED_DEFECT");

      // The cause the response was built from, without the response itself,
      // whose headers and body are not the log's to keep.
      assert.notInclude(line.cause, "HttpServerResponse");
    }),
  );

  it.effect("records cf-ray and an incoming trace id", () =>
    Effect.gen(function* () {
      const traceId = "0af7651916cd43dd8448eb211c80319c";

      const [handled, access] = yield* linesFor([
        get("/ok", {
          "cf-ray": "8f1d2c3b4a5e6f70-FRA",
          traceparent: `00-${traceId}-b7ad6b7169203331-01`,
        }),
      ]);

      assert.strictEqual(access.annotations.cfRay, "8f1d2c3b4a5e6f70-FRA");
      assert.strictEqual(access.traceId, traceId);
      assert.strictEqual(handled.traceId, traceId);
    }),
  );

  it.effect("leaves out a cf-ray that is too long or not plain", () =>
    Effect.gen(function* () {
      const lines = yield* linesFor(
        [
          "x".repeat(65),
          "RAY\u0085NEXT_LINE",
          "RAY\u009b31m",
          "RAY\t{}",
          "8f1d2c3b4a5e6f70-FRA, 8f1d2c3b4a5e6f71-FRA",
        ].map((cfRay) => get("/missing", { "cf-ray": cfRay })),
      );

      assert.lengthOf(lines, 5);

      for (const line of lines) {
        assert.notProperty(line.annotations, "cfRay");
      }

      const [longest] = yield* linesFor([
        get("/missing", { "cf-ray": "x".repeat(64) }),
      ]);

      assert.strictEqual(longest.annotations.cfRay, "x".repeat(64));
    }),
  );
});
