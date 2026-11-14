import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Logger, Schema } from "effect";

import {
  persistenceFailureFields,
  reportFailure,
} from "@node-effect/application";

const sentinels = /SECRET_SENTINEL|SQL_SENTINEL|PARAM_SENTINEL/;

// A persistence failure of the test's own, so the test does not depend on the
// users example.
class ProbeFailure extends Schema.TaggedError<ProbeFailure>()(
  "ProbeFailure",
  persistenceFailureFields(["read", "write"]),
) {}

const repositoryFailure = new ProbeFailure({
  operation: "read",
  cause: Object.assign(new Error("SECRET_SENTINEL"), {
    query: "select SQL_SENTINEL",
    params: ["PARAM_SENTINEL"],
  }),
  diagnostics: { reason: "ConnectionError", code: "ECONNREFUSED" },
});

type Reporter = (cause: Cause.Cause<unknown>) => Effect.Effect<void>;

// Runs `program` with `reporter`, logging as JSON lines, and returns them.
const reportedLines = <E>(
  program: Effect.Effect<void, E>,
  reporter: Reporter = reportFailure("Entry point failed"),
) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];

    const logger = Logger.map(Logger.formatJson, (line) => {
      lines.push(line);
    });

    yield* program.pipe(
      Effect.tapCause(reporter),
      Effect.exit,
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    );

    return lines.map((line) => JSON.parse(line));
  });

describe("reportFailure", () => {
  it.effect("logs a persistence failure once, as its safe report", () =>
    Effect.gen(function* () {
      for (const program of [
        Effect.fail(repositoryFailure),
        Effect.die(repositoryFailure),
      ]) {
        const lines = yield* reportedLines(program);

        assert.deepStrictEqual(
          lines.map((line) => [line.message, line.level]),
          [["Entry point failed", "ERROR"]],
        );

        const output = JSON.stringify(lines);

        assert.include(output, "ProbeFailure");
        assert.include(output, "ECONNREFUSED");
        assert.notMatch(output, sentinels);
      }
    }),
  );

  it.effect("keeps an unexpected failure's details", () =>
    Effect.gen(function* () {
      const lines = yield* reportedLines(
        Effect.die(new Error("UNEXPECTED_DEFECT")),
      );

      assert.lengthOf(lines, 1);
      assert.include(JSON.stringify(lines[0]), "UNEXPECTED_DEFECT");
    }),
  );

  it.effect("logs nothing when interrupted, a normal shutdown", () =>
    Effect.gen(function* () {
      const lines = yield* reportedLines(Effect.interrupt);

      assert.deepStrictEqual(lines, []);
    }),
  );

  it.effect("reduces what its redaction accepts, also as a defect", () =>
    Effect.gen(function* () {
      const isSecret = (value: unknown): value is string =>
        value === "SECRET_SENTINEL";

      const reporter = reportFailure("Entry point failed", {
        isSensitive: isSecret,
        report: () => "REDACTED",
      });

      const programs: ReadonlyArray<Effect.Effect<void, unknown>> = [
        Effect.fail("SECRET_SENTINEL"),
        Effect.die("SECRET_SENTINEL"),
        Effect.fail(repositoryFailure),
      ];

      for (const program of programs) {
        const lines = yield* reportedLines(program, reporter);

        assert.lengthOf(lines, 1);
        assert.notMatch(JSON.stringify(lines), sentinels);
      }

      const [unrelated] = yield* reportedLines(
        Effect.fail("UNRELATED_FAILURE"),
        reporter,
      );

      assert.include(JSON.stringify(unrelated), "UNRELATED_FAILURE");
    }),
  );
});
