import { assert, describe, it } from "@effect/vitest";

import { judgeCheckRun } from "./check-migrations.ts";

// Recorded from drizzle-kit 1.0.0-rc.5 `check --output json`: an unchanged
// schema, a schema with an index that no migration creates, and a schema path
// that matches no file.
const cleanReport = '{"status":"ok","dialect":"postgresql"}\n';

const schemaChangedMessage =
  "The schema differs from the migrations. The newest migration is 20261027103129_initial. Run drizzle-kit generate --explain to see the difference, and drizzle-kit generate to write a migration for it.";

const schemaChangedReport = `${JSON.stringify({
  status: "ok",
  dialect: "postgresql",
  warnings: [{ kind: "schema_changed", message: schemaChangedMessage }],
})}\n`;

const notComparedReport = `${JSON.stringify({
  status: "ok",
  dialect: "postgresql",
  warnings: [
    {
      kind: "not_compared",
      message:
        "The schema was not compared with the migrations, because no schema file matches ./packages/database/src/*/schema.ts. Correct the schema path in the config file or in the --schema option.",
    },
  ],
})}\n`;

// Recorded with DATABASE_URL unset, which makes drizzle.config.ts throw.
const errorReport =
  '{"status":"error","error":{"code":"unknown_error","message":"DATABASE_URL is required to run Drizzle Kit"}}\n';

const failureReason = (verdict: ReturnType<typeof judgeCheckRun>) =>
  verdict._tag === "Failed" ? verdict.reason : "(the check passed)";

const assertFailed = (
  verdict: ReturnType<typeof judgeCheckRun>,
  expectedReason: string,
) => {
  assert.include(failureReason(verdict), expectedReason);
};

describe("judgeCheckRun", () => {
  it("passes a report without warnings", () => {
    const verdict = judgeCheckRun({ exitCode: 0, stdout: cleanReport });

    assert.strictEqual(verdict._tag, "Passed");
  });

  it("passes an empty warning list", () => {
    const stdout = '{"status":"ok","dialect":"postgresql","warnings":[]}';

    assert.strictEqual(judgeCheckRun({ exitCode: 0, stdout })._tag, "Passed");
  });

  it("fails on drift, which drizzle-kit reports with exit code 0", () => {
    assertFailed(
      judgeCheckRun({ exitCode: 0, stdout: schemaChangedReport }),
      `schema_changed: ${schemaChangedMessage}`,
    );
  });

  it("fails when the schema files could not be compared", () => {
    assertFailed(
      judgeCheckRun({ exitCode: 0, stdout: notComparedReport }),
      "not_compared: The schema was not compared with the migrations",
    );
  });

  it("fails on an error report", () => {
    assertFailed(
      judgeCheckRun({ exitCode: 1, stdout: errorReport }),
      "DATABASE_URL is required to run Drizzle Kit",
    );
  });

  it("fails on a clean report with a nonzero exit code", () => {
    assertFailed(
      judgeCheckRun({ exitCode: 1, stdout: cleanReport }),
      "exited with 1",
    );

    assertFailed(
      judgeCheckRun({ exitCode: null, stdout: cleanReport }),
      "exited with null",
    );
  });

  it.each([
    ["no output", ""],
    ["text output", "Everything's fine 🐶🔥\n"],
    ["two reports", `${cleanReport}${cleanReport}`],
    ["another status", '{"status":"no_changes","dialect":"postgresql"}'],
    [
      "a renamed warnings field",
      '{"status":"ok","dialect":"postgresql","issues":[{"kind":"schema_changed","message":"drift"}]}',
    ],
    [
      "a warning with another shape",
      '{"status":"ok","dialect":"postgresql","warnings":["drift"]}',
    ],
  ])("fails on an unrecognised report: %s", (_name, stdout) => {
    assertFailed(judgeCheckRun({ exitCode: 0, stdout }), "does not recognise");
  });
});
