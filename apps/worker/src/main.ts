import { Effect } from "effect";

import { AppConfig } from "@uncross/config";

import { pollJobs } from "./job-runner.ts";
import { workerJobs } from "./jobs/worker-jobs.ts";
import { runWorker } from "./worker-runtime.ts";

const worker = AppConfig.pipe(
  Effect.flatMap((config) =>
    pollJobs(workerJobs, {
      intervalMs: config.workerPollIntervalMs,
      passTimeoutMs: config.workerPassTimeoutMs,
    }),
  ),
);

runWorker(worker);
