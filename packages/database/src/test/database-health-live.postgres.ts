import { describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { DatabaseHealth } from "@node-effect/application";

import { DatabaseHealthLive } from "../database-health-live.ts";

import { withMigratedDatabase } from "./migrated-database.fixtures.ts";

describe("DatabaseHealthLive on PostgreSQL", () => {
  it.live("is ready while PostgreSQL answers", () =>
    Effect.gen(function* () {
      const health = yield* DatabaseHealth;

      yield* health.check;
    }).pipe(withMigratedDatabase(DatabaseHealthLive)),
  );
});
