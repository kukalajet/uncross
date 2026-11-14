import type { Cause } from "effect";
import { Effect } from "effect";

import { reportFailure } from "@uncross/application";

// Logs a failure once, as every entry point does: a persistence failure by its
// safe diagnostics, also when one arrives as a defect, and nothing for
// interruption. Any other failure keeps its details: a pass timeout's
// TimeoutError names the job and the limit, and anything else is unexpected.
const reportWorkerFailure = (cause: Cause.Cause<unknown>) =>
  reportFailure("Worker failed")(cause).pipe(
    Effect.annotateLogs({ service: "worker" }),
  );

export { reportWorkerFailure };
