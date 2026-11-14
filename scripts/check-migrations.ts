import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { Result, Schema } from "effect";

// Fails when the schema files and the migrations in drizzle/ have drifted
// apart. `drizzle-kit check` (1.0.0-rc.5) compares them, but reports a
// difference as a warning and still exits 0, so a schema change without its
// migration, such as a new index that no test notices, would pass. Run by
// `pnpm db:verify` and `pnpm check`.

// What `drizzle-kit check --output json` prints on stdout. The warning kinds
// are `schema_changed`, `merge_needed` and `not_compared` (the schema files
// could not be loaded); every warning fails. So does any other shape, so that a
// drizzle-kit upgrade that changes the report cannot pass unnoticed.
const CheckWarning = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
});

const CheckReport = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    dialect: Schema.String,
    warnings: Schema.optionalKey(Schema.Array(CheckWarning)),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    error: Schema.Record(Schema.String, Schema.Unknown),
  }),
]);

const decodeCheckReport = Schema.decodeUnknownResult(
  Schema.fromJsonString(CheckReport),
  { onExcessProperty: "error" },
);

// drizzle.config.ts requires DATABASE_URL, which CI's check job and the image's
// check stage do not set. `check` reads only files, so nothing connects to this
// address; the `.invalid` top-level domain never resolves (RFC 2606).
const placeholderDatabaseUrl = "postgresql://unused@check.invalid/unused";

type CheckRun = {
  readonly exitCode: number | null;
  readonly stdout: string;
};

type CheckVerdict =
  | { readonly _tag: "Passed" }
  | { readonly _tag: "Failed"; readonly reason: string };

const failed = (reason: string): CheckVerdict => ({ _tag: "Failed", reason });

// Judges by the report rather than the exit code, which is 0 on drift.
const judgeCheckRun = ({ exitCode, stdout }: CheckRun): CheckVerdict => {
  const report = decodeCheckReport(stdout);

  if (Result.isFailure(report)) {
    return failed(
      [
        "drizzle-kit check printed a report this script does not recognise; update scripts/check-migrations.ts for this drizzle-kit version.",
        report.failure.message,
        `stdout: ${stdout}`,
      ].join("\n"),
    );
  }

  if (report.success.status === "error") {
    return failed(
      `drizzle-kit check failed: ${JSON.stringify(report.success.error)}`,
    );
  }

  const warnings = report.success.warnings ?? [];

  if (warnings.length > 0) {
    return failed(
      warnings.map(({ kind, message }) => `${kind}: ${message}`).join("\n"),
    );
  }

  if (exitCode !== 0) {
    return failed(
      `drizzle-kit check reported no warnings but exited with ${String(exitCode)}`,
    );
  }

  return { _tag: "Passed" };
};

// `pnpm run` puts `drizzle-kit` on the PATH. Its human-readable messages go to
// stderr, which passes through.
const runDrizzleKitCheck = (rootPath: string): CheckRun => {
  const result = spawnSync(
    "drizzle-kit",
    ["check", "--config=drizzle.config.ts", "--output", "json"],
    {
      cwd: rootPath,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: placeholderDatabaseUrl },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  if (result.error !== undefined) throw result.error;

  return { exitCode: result.status, stdout: result.stdout };
};

const main = () => {
  try {
    const rootPath = join(import.meta.dirname, "..");
    const verdict = judgeCheckRun(runDrizzleKitCheck(rootPath));

    switch (verdict._tag) {
      case "Passed":
        console.log("The migrations match the schema");
        break;
      case "Failed":
        console.error(verdict.reason);
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  main();
}

export { judgeCheckRun };
