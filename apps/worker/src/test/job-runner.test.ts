import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { pollJobs, runJobsOnce } from "../job-runner.ts";

const passTimeoutMs = 60_000;
const timings = { intervalMs: 1000, passTimeoutMs };

const jobFailure = new Error("JOB_FAILURE");

// A job whose pass adds its name to `ran`, `delayMs` after the pass starts.
const recordingJob = (name: string, ran: Array<string>, delayMs = 0) => ({
  name,
  pass: () =>
    Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          ran.push(name);
        }),
      ),
    ),
});

const failingJob = (name: string) => ({
  name,
  pass: () => Effect.fail(jobFailure),
});

// A job whose pass never finishes on its own.
const stalledJob = (name: string) => ({ name, pass: () => Effect.never });

describe("runJobsOnce", () => {
  it.effect("runs every job once, in order", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const run = yield* runJobsOnce(
        [recordingJob("slow", ran, 1000), recordingJob("fast", ran)],
        passTimeoutMs,
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust(1000);
      yield* Fiber.join(run);

      assert.deepStrictEqual(ran, ["slow", "fast"]);
    }),
  );

  it.effect("fails with the first failure, and later jobs never run", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const error = yield* runJobsOnce(
        [failingJob("failing"), recordingJob("later", ran)],
        passTimeoutMs,
      ).pipe(Effect.flip);

      assert.strictEqual(error, jobFailure);
      assert.deepStrictEqual(ran, []);
    }),
  );

  it.effect(
    "fails with a TimeoutError naming a job that outlives the pass timeout",
    () =>
      Effect.gen(function* () {
        const run = yield* runJobsOnce(
          [stalledJob("stalled-job")],
          passTimeoutMs,
        ).pipe(Effect.flip, Effect.forkScoped);

        yield* TestClock.adjust(passTimeoutMs);
        const error = yield* Fiber.join(run);

        assert(Cause.isTimeoutError(error));

        assert.match(
          error.message,
          /stalled-job ran longer than its 60000 ms pass timeout/,
        );
      }),
  );
});

describe("pollJobs", () => {
  it.effect("starts at once, never overlaps, and waits after each pass", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      let passes = 0;

      const job = {
        name: "slow-first-pass",
        pass: () =>
          Effect.gen(function* () {
            passes += 1;

            if (passes === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            } else {
              yield* Deferred.succeed(secondStarted, undefined);
            }
          }),
      };

      const worker = yield* pollJobs([job], timings).pipe(Effect.forkScoped);

      yield* Deferred.await(firstStarted);
      assert.strictEqual(passes, 1);
      yield* TestClock.adjust(5000);
      assert.strictEqual(passes, 1, "a slow pass must not overlap or queue");

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* TestClock.adjust(999);
      assert.strictEqual(passes, 1, "the interval starts after the pass ends");
      yield* TestClock.adjust(1);
      yield* Deferred.await(secondStarted);
      assert.strictEqual(passes, 2);

      yield* Fiber.interrupt(worker);
      yield* TestClock.adjust(5000);
      assert.strictEqual(passes, 2, "interruption stops future passes");
    }),
  );

  it.effect("starts a trace of its own for each pass", () =>
    Effect.gen(function* () {
      const firstPass = yield* Deferred.make<void>();
      const secondPass = yield* Deferred.make<void>();
      const traceIds: Array<string> = [];

      // Like a real job's Effect.fn, the pass opens a span of its own.
      const job = {
        name: "traced",
        pass: () =>
          Effect.gen(function* () {
            const span = yield* Effect.orDie(Effect.currentSpan);

            traceIds.push(span.traceId);

            yield* Deferred.succeed(
              traceIds.length === 1 ? firstPass : secondPass,
              undefined,
            );
          }).pipe(Effect.withSpan("Worker.tracedPass")),
      };

      yield* pollJobs([job], timings).pipe(Effect.forkScoped);

      yield* Deferred.await(firstPass);
      yield* TestClock.adjust(timings.intervalMs);
      yield* Deferred.await(secondPass);

      assert.lengthOf(traceIds, 2);
      assert.notStrictEqual(traceIds[0], traceIds[1]);
    }),
  );

  it.effect("fails with the first failed pass and polls no more", () =>
    Effect.gen(function* () {
      let passes = 0;

      const job = {
        name: "failing",
        pass: () =>
          Effect.suspend(() => {
            passes += 1;

            return Effect.fail(jobFailure);
          }),
      };

      const exit = yield* pollJobs([job], timings).pipe(Effect.exit);

      yield* TestClock.adjust(5000);

      assert(Exit.isFailure(exit));
      assert.strictEqual(Cause.squash(exit.cause), jobFailure);
      assert.strictEqual(passes, 1);
    }),
  );

  it.effect("ends with the original defect", () =>
    Effect.gen(function* () {
      const defect = new Error("UNEXPECTED_FAILURE");

      const exit = yield* pollJobs(
        [{ name: "dying", pass: () => Effect.die(defect) }],
        timings,
      ).pipe(Effect.exit);

      assert(Exit.isFailure(exit));
      assert.strictEqual(Cause.squash(exit.cause), defect);
    }),
  );

  it.effect("interrupting an active pass runs its cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let passes = 0;
      let cleanedUp = false;

      const job = {
        name: "interrupted",
        pass: () =>
          Effect.gen(function* () {
            passes += 1;
            yield* Deferred.succeed(started, undefined);

            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cleanedUp = true;
              }),
            ),
          ),
      };

      const worker = yield* pollJobs([job], timings).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(worker);
      const exit = yield* Fiber.await(worker);
      yield* TestClock.adjust(5000);

      assert(Exit.isFailure(exit));
      assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.isTrue(cleanedUp);
      assert.strictEqual(passes, 1);
    }),
  );

  it.effect(
    "fails when a pass outlives the pass timeout, interrupting it",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let cleanedUp = false;

        const job = {
          name: "stalled-job",
          pass: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleanedUp = true;
                }),
              ),
            ),
        };

        const worker = yield* pollJobs([job], timings).pipe(Effect.forkScoped);

        yield* Deferred.await(started);
        yield* TestClock.adjust(timings.passTimeoutMs - 1);

        assert.isUndefined(
          worker.pollUnsafe(),
          "a pass may run up to the limit",
        );

        yield* TestClock.adjust(1);
        const exit = yield* Fiber.await(worker);

        assert(Exit.isFailure(exit));
        const error = Cause.squash(exit.cause);
        assert(Cause.isTimeoutError(error));
        assert.match(error.message, /stalled-job/);
        assert.isTrue(cleanedUp, "the timed-out pass is interrupted");
      }),
  );

  it.effect("limits each pass, not the loop", () =>
    Effect.gen(function* () {
      let passes = 0;

      const job = {
        name: "quick",
        pass: () =>
          Effect.sync(() => {
            passes += 1;
          }),
      };

      const worker = yield* pollJobs([job], {
        intervalMs: 1000,
        passTimeoutMs: 1500,
      }).pipe(Effect.forkScoped);

      yield* TestClock.adjust(10_000);

      assert.isUndefined(worker.pollUnsafe());
      assert.strictEqual(passes, 11);
    }),
  );

  it.effect("never lets a stalled job delay another job's passes", () =>
    Effect.gen(function* () {
      let quickPasses = 0;

      const quick = {
        name: "quick",
        pass: () =>
          Effect.sync(() => {
            quickPasses += 1;
          }),
      };

      const worker = yield* pollJobs(
        [stalledJob("stalled"), quick],
        timings,
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust(5000);

      assert.isUndefined(
        worker.pollUnsafe(),
        "the stalled pass is within its limit",
      );

      assert.strictEqual(quickPasses, 6);
    }),
  );

  it.effect("interrupts the other jobs' passes when one job fails", () =>
    Effect.gen(function* () {
      const otherStarted = yield* Deferred.make<void>();
      let otherCleanedUp = false;

      const other = {
        name: "other",
        pass: () =>
          Deferred.succeed(otherStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                otherCleanedUp = true;
              }),
            ),
          ),
      };

      const failing = {
        name: "failing",
        pass: () =>
          Deferred.await(otherStarted).pipe(
            Effect.andThen(Effect.fail(jobFailure)),
          ),
      };

      const exit = yield* pollJobs([other, failing], timings).pipe(Effect.exit);

      assert(Exit.isFailure(exit));
      assert.strictEqual(Cause.squash(exit.cause), jobFailure);
      assert.isTrue(otherCleanedUp, "the other job's pass is interrupted");
    }),
  );
});

type FirstFailure = { readonly _tag: "FirstFailure" };
type SecondFailure = { readonly _tag: "SecondFailure" };

class FirstPort extends Context.Service<
  FirstPort,
  { readonly read: Effect.Effect<void, FirstFailure> }
>()("test/FirstPort") {}

class SecondPort extends Context.Service<
  SecondPort,
  { readonly read: Effect.Effect<void, SecondFailure> }
>()("test/SecondPort") {}

describe("job lists", () => {
  it("can hold jobs with different ports and errors, and need them all", () => {
    const jobs = [
      {
        name: "first",
        pass: () => FirstPort.pipe(Effect.flatMap((port) => port.read)),
      },
      {
        name: "second",
        pass: () => SecondPort.pipe(Effect.flatMap((port) => port.read)),
      },
    ] as const;

    type JobsRun = Effect.Effect<
      void,
      FirstFailure | SecondFailure | Cause.TimeoutError,
      FirstPort | SecondPort
    >;

    expectTypeOf(runJobsOnce(jobs, passTimeoutMs)).toEqualTypeOf<JobsRun>();
    expectTypeOf(pollJobs(jobs, timings)).toEqualTypeOf<JobsRun>();
  });

  it("cannot be empty", () => {
    // @ts-expect-error: a one-shot pass of no jobs would check nothing
    expectTypeOf(runJobsOnce).toBeCallableWith([], passTimeoutMs);
    // @ts-expect-error: with no jobs, polling would end at once and the worker would restart forever
    expectTypeOf(pollJobs).toBeCallableWith([], timings);
  });
});
