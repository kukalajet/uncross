import { Cause, Effect, Schedule } from "effect";

// A piece of recurring work the worker does, one pass at a time.
type WorkerJob = {
  // Names the job in its pass timeout's TimeoutError.
  readonly name: string;
  readonly pass: () => Effect.Effect<void, unknown, unknown>;
};

// A job table holds at least one job: with none, polling would end at once,
// the worker would exit 0, and its supervisor would start it again, forever.
type JobTable = readonly [WorkerJob, ...ReadonlyArray<WorkerJob>];

type JobPass<Jobs extends JobTable> = ReturnType<Jobs[number]["pass"]>;

// Running a job table fails as any of its passes can, or with a pass timeout,
// and needs what every pass needs.
type JobsRun<Jobs extends JobTable> = Effect.Effect<
  void,
  Effect.Error<JobPass<Jobs>> | Cause.TimeoutError,
  Effect.Services<JobPass<Jobs>>
>;

// A pass that never finishes would stall its loop without failing the worker,
// so nothing would restart it. Past `timeoutMs` the pass is interrupted, so its
// open transaction never commits, and fails with a TimeoutError that names the
// job. Passes stay interruptible, so SIGTERM stops one too. Either waits for
// the interrupted pass to finish: a query in flight takes the driver up to 5
// seconds to cancel when the server does not answer.
const runJobPass = (job: WorkerJob, timeoutMs: number) =>
  job.pass().pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new Cause.TimeoutError(
            `Worker job ${job.name} ran longer than its ${timeoutMs} ms pass timeout`,
          ),
        ),
    }),
  );

// One pass of every job, in order; the first failure ends it, so later jobs do
// not run. `once.ts` runs this.
// SAFETY: every pass run here comes from `jobs`, so what it fails with and what
// it needs belong to JobsRun<Jobs>; typing a job as WorkerJob only forgets
// which job it was.
const runJobsOnce = <const Jobs extends JobTable>(
  jobs: Jobs,
  passTimeoutMs: number,
) =>
  Effect.forEach(jobs, (job) => runJobPass(job, passTimeoutMs), {
    discard: true,
  }).pipe(Effect.withSpan("Worker.runJobsOnce")) as JobsRun<Jobs>;

// Each job polls on its own loop, so a slow job never delays another. A loop
// waits `intervalMs` after a pass finishes, so passes of one job never overlap.
// The first failure interrupts every loop and fails the worker; the process
// supervisor (Compose `restart: unless-stopped`) starts it again. The loops run
// outside any span, so each pass starts a trace of its own. `main.ts` runs
// this.
// SAFETY: as in runJobsOnce, every pass run here comes from `jobs`.
const pollJobs = <const Jobs extends JobTable>(
  jobs: Jobs,
  options: { readonly intervalMs: number; readonly passTimeoutMs: number },
) =>
  Effect.forEach(
    jobs,
    (job) =>
      runJobPass(job, options.passTimeoutMs).pipe(
        Effect.repeat(Schedule.spaced(options.intervalMs)),
      ),
    { concurrency: "unbounded", discard: true },
  ) as JobsRun<Jobs>;

export { type JobTable, pollJobs, runJobsOnce, type WorkerJob };
