import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DatabaseHealth, DatabaseHealthError } from "@node-effect/application";

import { Api } from "../../api-contract.ts";
import { serveGroup } from "../../test/group-server.fixtures.ts";
import { HealthHandlers } from "../routes.ts";

// Serves the health routes with a database health check, checking every
// response against the health contract.
const serve = serveGroup(Api.groups.health, HealthHandlers);

const get = (path: string) => new Request(`http://localhost${path}`);

const databaseUnavailable = new DatabaseHealthError({
  operation: "check",
  cause: new Error("Unreachable PostgreSQL"),
  diagnostics: { reason: "ConnectionError", code: "ECONNREFUSED" },
});

// A database health check that succeeds or fails and counts its calls.
const databaseHealth = (available: boolean) => {
  const health = { checks: 0 };

  const layer = Layer.mock(DatabaseHealth, {
    check: Effect.suspend(() => {
      health.checks += 1;
      if (available) return Effect.void;

      return Effect.fail(databaseUnavailable);
    }),
  });

  return { health, layer };
};

describe("health routes", () => {
  for (const available of [true, false]) {
    const state = available ? "available" : "down";

    it(`liveness answers 200 without the database while it is ${state}`, async () => {
      const database = databaseHealth(available);
      const server = serve(database.layer);
      const response = await server.fetch(get("/health/live"));

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { status: "ok" });
      assert.strictEqual(database.health.checks, 0);
    });
  }

  for (const path of ["/health/ready", "/health"]) {
    it(`${path} answers 200 when the database is available`, async () => {
      const database = databaseHealth(true);
      const server = serve(database.layer);
      const response = await server.fetch(get(path));

      assert.strictEqual(response.status, 200);

      assert.deepStrictEqual(await response.json(), {
        status: "ok",
        database: "ok",
      });

      assert.strictEqual(database.health.checks, 1);
    });

    it(`${path} answers 503 when the database is down`, async () => {
      const database = databaseHealth(false);
      const server = serve(database.layer);
      const response = await server.fetch(get(path));

      assert.strictEqual(response.status, 503);

      assert.deepStrictEqual(await response.json(), {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "The database is unavailable",
        },
      });

      assert.strictEqual(database.health.checks, 1);
    });
  }
});
