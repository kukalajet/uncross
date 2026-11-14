import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { reportFailure } from "@node-effect/application";
import { AppConfig, LoggingLive } from "@node-effect/config";

import { accessLog } from "./access-log.ts";
import { ApiRoutes } from "./app.ts";
import { RequestServicesLive } from "./request-services-live.ts";

// cloudflared keeps an idle connection to the API for 90 s before dropping it
// (its originRequest.keepAliveTimeout default). Node closes idle sockets after
// 5 s, so cloudflared could send a request on a socket Node is closing and
// answer it with a 502. Waiting longer leaves closing idle sockets to
// cloudflared. headersTimeout only runs while a request's headers arrive, not
// while a socket is idle, so it keeps its default.
const cloudflaredIdleSocketMs = 90_000;
const keepAliveTimeoutMs = cloudflaredIdleSocketMs + 5_000;

const createHttpServer = () =>
  createServer({ keepAliveTimeout: keepAliveTimeoutMs });

const HttpServerLive = Layer.unwrap(
  AppConfig.pipe(
    Effect.map((config) =>
      NodeHttpServer.layer(createHttpServer, {
        host: config.apiHost,
        port: config.apiPort,
        gracefulShutdownTimeout: "10 seconds",
      }),
    ),
  ),
);

// accessLog replaces Effect's own HTTP logger, which would log every response,
// passing health probes included, at Info with its raw cause.
// test/main.test.ts runs this file to check that it stays off.
const ServerLive = HttpRouter.serve(
  ApiRoutes.pipe(HttpRouter.provideRequest(RequestServicesLive)),
  { disableLogger: true, middleware: accessLog },
).pipe(Layer.provide(HttpServerLive), Layer.provide(AppConfig.layer));

// reportFailure logs a failure to start or serve as JSON, inside
// LoggingLive. runMain's own reporting stays off: it would log the raw cause
// again, as text, outside LoggingLive. test/main.test.ts checks this too.
const main = Layer.launch(ServerLive).pipe(
  Effect.tapCause(reportFailure("API failed")),
  Effect.provide(LoggingLive),
);

NodeRuntime.runMain(main, { disableErrorReporting: true });
