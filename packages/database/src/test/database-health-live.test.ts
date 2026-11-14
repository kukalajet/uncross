import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { DatabaseHealth, DatabaseHealthError } from "@uncross/application";

import { DatabaseHealthLive } from "../database-health-live.ts";
import { DatabaseLive } from "../postgres.ts";

import { pgClientLayer, stalledConnection } from "./pg-client.ts";

// A database that accepts the query and never answers it. Readiness must give
// up on its own, so this check cannot run against a responsive PostgreSQL.
const stalledHealth = DatabaseHealthLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(pgClientLayer(Effect.succeed(stalledConnection))),
);

describe("DatabaseHealthLive", () => {
  it.effect("stops waiting for a stalled query after five seconds", () =>
    Effect.gen(function* () {
      const health = yield* DatabaseHealth;
      const fiber = yield* health.check.pipe(Effect.flip, Effect.forkScoped);

      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(fiber);

      assert.instanceOf(failure, DatabaseHealthError);
      assert.strictEqual(failure.operation, "check");
      assert.deepStrictEqual(failure.diagnostics, { reason: "TimeoutError" });
    }).pipe(Effect.provide(stalledHealth)),
  );
});
