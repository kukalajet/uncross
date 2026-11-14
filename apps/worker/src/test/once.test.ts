import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

// once.ts is where the worker's layers, its failure reporter, LoggingLive and
// runMain's settings meet. Out of order, a failure exits 1 without a line
// while each module's tests still pass, so these run once.ts as the process it
// is. Neither needs PostgreSQL.
const oncePath = fileURLToPath(new URL("../once.ts", import.meta.url));

// Port 1 refuses connections at once; the password must never reach the log.
const unreachableDatabaseUrl =
  "postgresql://app:SECRET_SENTINEL@127.0.0.1:1/app";

// Runs once.ts with only `env`, so neither the shell's LOG_LEVEL nor .env
// changes the result.
const runOnce = (env: Record<string, string>) => {
  const { status, stdout, stderr } = spawnSync(process.execPath, [oncePath], {
    env,
    encoding: "utf8",
  });

  const lines = stdout
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

  return { status, stdout, stderr, lines };
};

describe("apps/worker/src/once.ts", () => {
  it("reports missing configuration once, as JSON, and exits 1", () => {
    const { status, stderr, lines } = runOnce({});

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr, "");

    assert.deepStrictEqual(
      lines.map((line) => [line.message, line.level, line.annotations]),
      [["Worker failed", "ERROR", { service: "worker" }]],
    );

    assert.include(lines[0]?.cause, "DATABASE_URL");
  });

  it("reports a database it cannot reach by safe diagnostics, and exits 1", () => {
    const { status, stdout, stderr, lines } = runOnce({
      DATABASE_URL: unreachableDatabaseUrl,
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr, "");

    assert.deepStrictEqual(
      lines.map((line) => [line.message, line.level]),
      [["Worker failed", "ERROR"]],
    );

    // The table's own jobs decide which persistence failure it is; any of them
    // carries these diagnostics.
    assert.include(
      lines[0]?.cause,
      '"diagnostics":{"reason":"ConnectionError","code":"ECONNREFUSED"}',
    );

    assert.notInclude(stdout, "SECRET_SENTINEL");
  });
});
