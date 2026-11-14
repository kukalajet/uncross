import { Effect } from "effect";

import { AppConfig } from "@node-effect/config";

import { runJobsOnce } from "./job-runner.ts";
import { workerJobs } from "./jobs/worker-jobs.ts";
import { runWorker } from "./worker-runtime.ts";

const pass = AppConfig.pipe(
  Effect.flatMap((config) =>
    runJobsOnce(workerJobs, config.workerPassTimeoutMs),
  ),
);

runWorker(pass);
