import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";

import { AppConfig, LoggingLive } from "@node-effect/config";
import {
  DatabaseLive,
  PgClientLive,
  UserRepositoryLive,
} from "@node-effect/database";

import { reportWorkerFailure } from "./worker-errors.ts";

// The adapters behind the worker's ports, and AppConfig, built once for both
// PgClientLive and the program. Add the adapters a new job's ports need here.
const WorkerServicesLive = UserRepositoryLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(PgClientLive),
  Layer.provideMerge(AppConfig.layer),
);

// Everything a worker program may use: what WorkerServicesLive provides.
type WorkerRequirements = Layer.Success<typeof WorkerServicesLive>;

// Runs `program` as the process: 0 when it completes, 1 when it fails, 130
// when SIGINT or SIGTERM interrupts it. reportWorkerFailure logs failures, so
// the runtime's own reporting is off; it would log the raw cause.
const runWorker = <E>(program: Effect.Effect<void, E, WorkerRequirements>) => {
  const worker = program.pipe(
    Effect.provide(WorkerServicesLive),
    Effect.tapCause(reportWorkerFailure),
    Effect.provide(LoggingLive),
  );

  NodeRuntime.runMain(worker, { disableErrorReporting: true });
};

export { runWorker };
