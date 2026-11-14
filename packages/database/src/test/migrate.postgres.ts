import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PgClient } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import {
  Config,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";

import { diagnosticsFromCause } from "../error-diagnostics.ts";
import { migrateDatabase } from "../migrate.ts";

import { withEmptyDatabase } from "./migrated-database.fixtures.ts";

const migrationsFolder = join(import.meta.dirname, "../../../../drizzle");

const migrationNames = readdirSync(migrationsFolder).sort();

// The part of the snapshot drizzle-kit writes beside each migration that lists
// the schema's entities, tables among them, as of that migration.
const MigrationSnapshot = Schema.fromJsonString(
  Schema.Struct({
    ddl: Schema.Array(
      Schema.Struct({ entityType: Schema.String, name: Schema.String }),
    ),
  }),
);

// The tables the migrations leave behind, from the latest snapshot, so the
// check holds whatever tables a project adds or later drops.
const migratedTableNames = () => {
  const latest = migrationNames.at(-1);
  assert.isDefined(latest);

  const snapshot = Schema.decodeUnknownSync(MigrationSnapshot)(
    readFileSync(join(migrationsFolder, latest, "snapshot.json"), "utf8"),
  );

  return snapshot.ddl
    .filter((entity) => entity.entityType === "tables")
    .map((entity) => entity.name);
};

// The test schema is first on the search path. Keeping the journal there too
// isolates it from the shared `drizzle` schema.
const currentSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [schema] = yield* sql<{
    readonly name: string;
  }>`select current_schema() as name`;

  assert.isDefined(schema);

  return schema.name;
});

const tableNames = (schema: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const tables = yield* sql<{ readonly name: string }>`
      select table_name as name from information_schema.tables
      where table_schema = ${schema} order by table_name
    `;

    return tables.map((table) => table.name);
  });

// The lock test waits out the migration client's 5 second lock timeout.
const lockTestTimeoutMs = 20_000;

// A second session, as the API or a long-running transaction would hold.
const otherSession = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("DATABASE_URL");

    return PgClient.layer({ url });
  }),
);

describe("migrateDatabase", () => {
  it.live("applies each migration once and records it in the journal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = yield* currentSchema;

      yield* migrateDatabase(schema);
      yield* migrateDatabase(schema);

      const journal = yield* sql<{ readonly name: string }>`
        select name from ${sql(schema)}.__drizzle_migrations order by id
      `;

      assert.deepStrictEqual(
        journal.map((migration) => migration.name),
        migrationNames,
      );

      const tables = yield* tableNames(schema);

      assert.deepStrictEqual(
        tables.toSorted(),
        ["__drizzle_migrations", ...migratedTableNames()].toSorted(),
      );
    }).pipe(withEmptyDatabase),
  );

  it.live(
    "gives up on a lock another session holds and applies nothing",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const schema = yield* currentSchema;
        const journal = sql`${sql(schema)}.__drizzle_migrations`;

        // An empty journal of the shape drizzle creates, so the migrator applies
        // every migration and then waits to record them.
        yield* sql`
        create table ${journal} (
          id serial primary key,
          hash text not null,
          created_at bigint,
          name text,
          applied_at timestamp with time zone default now()
        )
      `;

        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        // Blocks writes to the journal until released, as an open transaction
        // blocks an ALTER TABLE on a table it read.
        const lockHolder = yield* SqlClient.SqlClient.use((other) =>
          other.withTransaction(
            Effect.gen(function* () {
              yield* other`lock table ${journal} in share mode`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          ),
        ).pipe(Effect.provide(otherSession), Effect.forkChild);

        yield* Deferred.await(locked);

        const [waited, error] = yield* migrateDatabase(schema).pipe(
          Effect.flip,
          Effect.timed,
        );

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(lockHolder);

        const recorded = yield* sql`select id from ${journal}`;

        assert.deepStrictEqual(diagnosticsFromCause(error), {
          reason: "LockTimeoutError",
          code: "55P03",
        });

        assert.isAtLeast(Duration.toMillis(waited), 4500);
        assert.isBelow(Duration.toMillis(waited), 10_000);

        assert.deepStrictEqual(yield* tableNames(schema), [
          "__drizzle_migrations",
        ]);

        assert.lengthOf(recorded, 0);
      }).pipe(withEmptyDatabase),
    lockTestTimeoutMs,
  );
});
