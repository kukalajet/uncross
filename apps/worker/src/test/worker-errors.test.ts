import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  References,
  Schema,
} from "effect";

import { persistenceFailureFields } from "@node-effect/application";

import { pollJobs, runJobsOnce } from "../job-runner.ts";
import { reportWorkerFailure } from "../worker-errors.ts";

// A persistence failure of the test's own, so the test does not depend on the
// users example.
class ProbeFailure extends Schema.TaggedError<ProbeFailure>()(
  "ProbeFailure",
  persistenceFailureFields(["read", "write"]),
) {}

const sentinels = /SECRET_SENTINEL|SQL_SENTINEL|PARAM_SENTINEL/;

// Runs `program` through the worker's failure reporter and returns how it
// ended and the JSON lines it logged, a job's Debug line included. main.test.ts
// and once.test.ts run the entry points themselves, with their layers,
// LoggingLive and runMain.
const runReported = <E>(program: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];

    const logger = Logger.map(Logger.formatJson, (line) => {
      lines.push(line);
    });

    const exit = yield* program.pipe(
      Effect.tapCause(reportWorkerFailure),
      Effect.provide([
        Logger.layer([logger]),
        Layer.succeed(References.MinimumLogLevel, "Debug"),
      ]),
      Effect.exit,
    );

    return { exit, lines };
  });

const repositoryFailure = () =>
  new ProbeFailure({
    operation: "read",
    cause: Object.assign(new Error("SECRET_SENTINEL"), {
      query: "select SQL_SENTINEL",
      params: ["PARAM_SENTINEL"],
    }),
    diagnostics: { reason: "AuthorizationError", code: "42501" },
  });

const failingJob = (error: unknown) => ({
  name: "failing",
  pass: () => Effect.fail(error),
});

// A port of the test's own, so a failure can come from building its layer, as
// a worker's does at startup.
class JobPort extends Context.Service<
  JobPort,
  { readonly run: Effect.Effect<void, unknown> }
>()("test/JobPort") {}

const portJob = {
  name: "port",
  pass: () => JobPort.pipe(Effect.flatMap((port) => port.run)),
};

const unexpectedError = new Error("UNEXPECTED_FAILURE");

describe("worker failure reporting", () => {
  it.effect("logs a persistence failure once, with safe diagnostics", () =>
    Effect.gen(function* () {
      const error = repositoryFailure();
      let finalized = false;

      const { exit, lines } = yield* runReported(
        runJobsOnce([failingJob(error)], 60_000).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );

      assert(Exit.isFailure(exit));
      assert.strictEqual(Cause.squash(exit.cause), error);
      assert.isTrue(finalized);
      assert.lengthOf(lines, 1);
      const line = lines.join("");
      const log = JSON.parse(line);
      assert.strictEqual(log.level, "ERROR");
      assert.strictEqual(log.message, "Worker failed");
      assert.deepStrictEqual(log.annotations, { service: "worker" });
      assert.match(line, /ProbeFailure/);
      assert.match(line, /AuthorizationError/);
      assert.match(line, /42501/);
      assert.notMatch(line, sentinels);
    }),
  );

  it.effect("logs the polling loop that fails, once", () =>
    Effect.gen(function* () {
      const { lines } = yield* runReported(
        pollJobs([failingJob(repositoryFailure())], {
          intervalMs: 60_000,
          passTimeoutMs: 60_000,
        }),
      );

      assert.lengthOf(lines, 1);
      assert.match(lines.join(""), /Worker failed/);
      assert.notMatch(lines.join(""), sentinels);
    }),
  );

  it.live("logs a pass that outlives its timeout by its job", () =>
    Effect.gen(function* () {
      let interrupted = false;

      const stalledJob = {
        name: "stalled-job",
        pass: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      };

      const { lines } = yield* runReported(runJobsOnce([stalledJob], 10));

      assert.isTrue(interrupted);
      assert.lengthOf(lines, 1);
      const line = lines.join("");
      assert.match(line, /Worker failed/);
      assert.match(line, /TimeoutError/);
      assert.match(line, /stalled-job ran longer than its 10 ms pass timeout/);
    }),
  );

  for (const testCase of [
    {
      name: "startup failure",
      program: runJobsOnce([portJob], 60_000).pipe(
        Effect.provide(Layer.effect(JobPort, Effect.fail(unexpectedError))),
      ),
    },
    { name: "defect", program: Effect.die(unexpectedError) },
  ]) {
    it.effect(`keeps the details of an unexpected ${testCase.name}`, () =>
      Effect.gen(function* () {
        const { exit, lines } = yield* runReported(testCase.program);

        assert(Exit.isFailure(exit));
        assert.strictEqual(Cause.squash(exit.cause), unexpectedError);
        assert.lengthOf(lines, 1);
        assert.match(lines.join(""), /UNEXPECTED_FAILURE/);
      }),
    );
  }

  it.effect(
    "reports a cleanup defect alongside a safe persistence failure",
    () =>
      Effect.gen(function* () {
        const error = repositoryFailure();
        const cleanupError = new Error("CLEANUP_FAILURE");

        const { exit, lines } = yield* runReported(
          runJobsOnce([portJob], 60_000).pipe(
            Effect.provide(
              Layer.effect(
                JobPort,
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Effect.die(cleanupError));

                  return JobPort.of({ run: Effect.fail(error) });
                }),
              ),
            ),
          ),
        );

        assert(Exit.isFailure(exit));
        assert.lengthOf(exit.cause.reasons, 2);
        assert.strictEqual(Cause.squash(exit.cause), error);
        assert.lengthOf(lines, 1);
        const output = lines.join("");
        assert.match(output, /AuthorizationError/);
        assert.match(output, /CLEANUP_FAILURE/);
        assert.notMatch(output, sentinels);
      }),
  );

  it.effect("logs nothing for an interruption", () =>
    Effect.gen(function* () {
      let finalized = false;

      const { exit, lines } = yield* runReported(
        Effect.interrupt.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );

      assert(Exit.isFailure(exit));
      assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.isTrue(finalized);
      assert.deepStrictEqual(lines, []);
    }),
  );

  it.effect("logs only a successful pass's own output", () =>
    Effect.gen(function* () {
      const loggingJob = {
        name: "logging",
        pass: () => Effect.logDebug("Job pass finished"),
      };

      const { exit, lines } = yield* runReported(
        runJobsOnce([loggingJob], 60_000),
      );

      assert.isTrue(Exit.isSuccess(exit));
      assert.lengthOf(lines, 1);
      assert.match(lines.join(""), /Job pass finished/);
    }),
  );
});
