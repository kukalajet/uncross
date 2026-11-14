import { Cause, Clock, Effect, Exit, Option } from "effect";
import {
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";

import { redactPersistenceFailures } from "@uncross/application";

// Compose's healthcheck and bin/release poll these every few seconds; only a
// probe that fails is worth a line.
const healthProbePaths = new Set(["/health", "/health/live", "/health/ready"]);

const isServerError = (status: number) => status >= 500;

const isPassingHealthProbe = (path: string, status: number) =>
  healthProbePaths.has(path) && status < 400;

// Cloudflare's request id, such as 8f1d2c3b4a5e6f70-FRA. Only the tunnel sets
// it in production, but any client can send one to a local API, and Node lets
// a header carry bytes such as NEL (0x85) and CSI (0x9b), which JSON leaves as
// they are and some readers take for a line break or a terminal command. Only
// a short, plain value is logged: checking the characters rather than
// Cloudflare's exact format, which could change.
const cfRayPattern = /^[0-9A-Za-z-]{1,64}$/;

const cfRayOf = (request: HttpServerRequest.HttpServerRequest) => {
  const cfRay = request.headers["cf-ray"];

  if (cfRay === undefined || !cfRayPattern.test(cfRay)) return undefined;

  return cfRay;
};

// Where a request target's path ends: its query string or fragment.
const pathEnd = /[?#]/;

// The query string can carry tokens or personal data, so only the path is
// logged.
const pathOf = (url: string) => {
  const end = url.search(pathEnd);

  return end === -1 ? url : url.slice(0, end);
};

type Outcome = {
  readonly response: HttpServerResponse.HttpServerResponse;
  readonly cause: Option.Option<Cause.Cause<unknown>>;
};

// A failed request's cause carries the response it was answered with.
const outcomeOf = <E>(
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, E>,
): Outcome => {
  if (Exit.isSuccess(exit)) {
    return { response: exit.value, cause: Option.none() };
  }

  const [response, cause] = HttpServerError.causeResponseStripped(exit.cause);

  return { response, cause };
};

// The cause can carry a persistence failure's SQL, parameters and stored
// values, also as a defect, so those are reduced to their safe report. A
// client error's cause, such as RouteNotFound, repeats the URL with its query
// string, so only server errors log one.
const serverErrorCause = (outcome: Outcome) => {
  if (!isServerError(outcome.response.status)) return [];

  return Option.match(outcome.cause, {
    onNone: () => [],
    onSome: (cause) => [redactPersistenceFailures(cause)],
  });
};

// One line per request, after the response is sent, in place of Effect's
// built-in logger, which logs every request at Info with the raw cause. The
// trace and span ids come from LoggingLive.
const accessLog = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(app);
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
    const outcome = outcomeOf(exit);
    const path = pathOf(request.url);
    const status = outcome.response.status;

    if (isPassingHealthProbe(path, status)) return yield* exit;

    const level = isServerError(status) ? "Error" : "Info";
    const cfRay = cfRayOf(request);

    yield* Effect.logWithLevel(level)(
      "Sent HTTP response",
      ...serverErrorCause(outcome),
    ).pipe(
      Effect.annotateLogs({
        method: request.method,
        path,
        status,
        durationMs,
        ...(cfRay === undefined ? {} : { cfRay }),
      }),
    );

    return yield* exit;
  }),
);

export { accessLog };
