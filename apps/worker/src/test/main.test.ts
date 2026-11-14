import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

// main.ts composes the polling worker the way once.ts composes a one-shot
// pass, and only the process shows how its failures and signals end it.
// Neither test needs PostgreSQL.
const mainPath = fileURLToPath(new URL("../main.ts", import.meta.url));

describe("apps/worker/src/main.ts", () => {
  it("reports missing configuration once, as JSON, and exits 1", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [mainPath], {
      env: {},
      encoding: "utf8",
    });

    const lines = stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.strictEqual(status, 1);
    assert.strictEqual(stderr, "");

    assert.deepStrictEqual(
      lines.map((line) => [line.message, line.level]),
      [["Worker failed", "ERROR"]],
    );

    assert.include(lines[0]?.cause, "DATABASE_URL");
  });

  it("stops a pass in flight on SIGTERM, logs nothing, and exits 130", async () => {
    // Accepts connections and never answers, like a PostgreSQL that stopped
    // responding, so the first pass is still waiting when SIGTERM arrives.
    const server = createServer(() => {}).listen(0, "127.0.0.1");

    try {
      await once(server, "listening");
      const address = server.address();

      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }

      const connected = once(server, "connection");

      const child = spawn(process.execPath, [mainPath], {
        env: { DATABASE_URL: `postgresql://app@127.0.0.1:${address.port}/app` },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });

      const exited = once(child, "exit");

      await connected;
      child.kill("SIGTERM");
      const [code] = await exited;

      assert.strictEqual(code, 130);
      assert.strictEqual(stdout, "");
      assert.strictEqual(stderr, "");
    } finally {
      server.close();
    }
  });
});
