import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

// main.ts alone turns off Effect's HTTP logger and runMain's own reporting.
// With either back on, the process logs raw causes, query strings or every
// health probe while each module's tests still pass, so these run main.ts as
// the process it is.
const mainPath = fileURLToPath(new URL("../main.ts", import.meta.url));

// Only these variables, so neither the shell's LOG_LEVEL nor .env changes
// the result. The API connects to PostgreSQL only when a request needs it.
const apiEnv = {
  API_HOST: "127.0.0.1",
  DATABASE_URL: "postgresql://app@127.0.0.1:1/app",
};

const listeningPattern = /^Listening on (?<origin>http:\/\/\S+)$/;

// API_PORT must be 1 to 65535, so the system picks a free port here instead.
const freePort = async () => {
  const server = createServer().listen(0, "127.0.0.1");

  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");

  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }

  return String(address.port);
};

// Starts main.ts and collects what it writes.
const startApi = async () => {
  const env = { ...apiEnv, API_PORT: await freePort() };
  const child = spawn(process.execPath, [mainPath], { env });
  const lines: Array<string> = [];
  const errors: Array<string> = [];

  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
  });

  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    errors.push(chunk);
  });

  return { child, lines, errors, exited: once(child, "exit") };
};

// Waits for a line that contains `text`: the API writes a request's line
// after it sends the response.
const waitForLine = async (lines: ReadonlyArray<string>, text: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const line = lines.find((candidate) => candidate.includes(text));

    if (line !== undefined) return line;

    await sleep(50);
  }

  throw new Error(`The API never logged ${text}:\n${lines.join("\n")}`);
};

describe("apps/api/src/main.ts", () => {
  it("logs a request without its query and no passing health probe", async () => {
    const api = await startApi();

    try {
      const listening = await waitForLine(api.lines, "Listening on");

      const origin = listeningPattern.exec(JSON.parse(listening).message)
        ?.groups?.["origin"];

      assert.isDefined(origin);
      const live = await fetch(`${origin}/health/live`);
      await live.arrayBuffer();
      const missing = await fetch(`${origin}/nope?token=QUERY_SENTINEL`);
      await missing.arrayBuffer();
      assert.strictEqual(live.status, 200);
      assert.strictEqual(missing.status, 404);
      await waitForLine(api.lines, '"path":"/nope"');
    } finally {
      api.child.kill("SIGTERM");
    }

    const [code] = await api.exited;
    const lines = api.lines.map((line) => JSON.parse(line));

    // SIGTERM interrupts the server, a normal shutdown with nothing to report.
    assert.strictEqual(code, 130);
    assert.deepStrictEqual(api.errors, []);

    // Effect's logger would add a line for each request, the probe included,
    // and a 404's cause, which repeats the query string.
    assert.deepStrictEqual(
      lines.map((line) => [
        String(line.message).replace(listeningPattern, "Listening on"),
        line.level,
        line.annotations.path,
        line.annotations.status,
        line.cause,
      ]),
      [
        ["Listening on", "INFO", undefined, undefined, undefined],
        ["Sent HTTP response", "INFO", "/nope", 404, undefined],
      ],
    );

    assert.notInclude(api.lines.join("\n"), "QUERY_SENTINEL");
  });

  it("reports a failure to start once, as JSON, and exits 1", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [mainPath], {
      env: { ...apiEnv, API_PORT: "not-a-port" },
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
      [["API failed", "ERROR"]],
    );

    assert.include(lines[0]?.cause, "API_PORT");
  });
});
