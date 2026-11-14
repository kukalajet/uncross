import type { JobTable } from "../job-runner.ts";

import { sampleUsersPass } from "./sample-users.ts";

// Every job the worker runs. Add a job here, and both the one-shot pass and
// polling run it; WorkerServicesLive must provide the adapters its ports need.
const workerJobs = [
  { name: "sample-users", pass: sampleUsersPass },
] as const satisfies JobTable;

export { workerJobs };
