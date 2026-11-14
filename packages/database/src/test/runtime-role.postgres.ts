import { PgClient } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import type { RuntimeRole } from "@node-effect/config";

import { diagnosticsFromCause } from "../error-diagnostics.ts";
import { migrateDatabase } from "../migrate.ts";
import { checkRuntimeRole, provisionRuntimeRole } from "../runtime-role.ts";

import { withEmptyDatabase } from "./migrated-database.fixtures.ts";

// The test database's owner, as `migrate` connects. Reading pg_authid and
// creating a superuser below need it to be a superuser, as the official
// PostgreSQL image makes POSTGRES_USER.
const ownerSql = SqlClient.SqlClient;

const firstRow = <A>(rows: ReadonlyArray<A>) => {
  const [row] = rows;
  assert.isDefined(row);

  return row;
};

const dropRole = (name: string) =>
  ownerSql
    .use((sql) =>
      Effect.gen(function* () {
        const roles = yield* sql`select from pg_roles where rolname = ${name}`;
        if (roles.length === 0) return;

        // Revokes what was granted to the role in this database, its default
        // privileges included, so that it can be dropped.
        yield* sql`drop owned by ${sql(name)}`;
        yield* sql`drop role ${sql(name)}`;
      }),
    )
    .pipe(Effect.orDie);

// Roles belong to the whole cluster, not to the test's schema, so each test
// names its own and drops it at the end.
const withRoleName = <A, E, R>(use: (name: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(
      () => `test_role_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ),
    use,
    dropRole,
  );

type Schemas = { readonly tables: string; readonly journal: string };

// Applies the migrations to the test's schema and keeps their journal in a
// schema of its own, as production keeps it in `drizzle`. The migrations'
// tables belong to the project's features, so the checks below run on
// probe_items, which is created next to them, before any role is provisioned,
// with a sequence as a serial column has.
const withMigrations = <A, E, R>(
  use: (schemas: Schemas) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* ownerSql;

    const { name: tables } = firstRow(
      yield* sql<{ readonly name: string }>`select current_schema() as name`,
    );

    const journal = `${tables}_journal`;

    return yield* Effect.acquireUseRelease(
      sql`create schema ${sql(journal)}`,
      () =>
        migrateDatabase(journal).pipe(
          Effect.andThen(
            sql`
              create table ${sql(tables)}.probe_items (
                id bigserial primary key,
                label text not null
              )
            `,
          ),
          Effect.andThen(use({ tables, journal })),
        ),
      () => sql`drop schema ${sql(journal)} cascade`.pipe(Effect.orDie),
    );
  });

// Runs `use` on a session of the role's own, logged in with its password.
const asRole = <A, E>(
  role: RuntimeRole,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  SqlClient.SqlClient.use(use).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("DATABASE_URL");

          return PgClient.layer({
            url,
            username: role.name,
            password: role.password,
            maxConnections: 1,
          });
        }),
      ),
    ),
  );

const sqlStateOf = (error: unknown) => diagnosticsFromCause(error).code;

const tableNames = (schema: string) =>
  ownerSql.use((sql) =>
    sql<{ readonly name: string }>`
      select table_name as name from information_schema.tables
      where table_schema = ${schema} order by table_name
    `.pipe(Effect.map((rows) => rows.map((row) => row.name))),
  );

describe("provisionRuntimeRole", () => {
  it.live(
    "lets the role read and write the application tables, also on a second run",
    () =>
      withRoleName((name) =>
        withMigrations(({ tables }) =>
          Effect.gen(function* () {
            const sql = yield* ownerSql;
            const role = { name, password: Redacted.make("runtime-password") };

            yield* provisionRuntimeRole(role, tables);
            yield* provisionRuntimeRole(role, tables);

            // Created after provisioning, as `drizzle-kit migrate` would: the
            // owner's default privileges cover it and its sequence.
            yield* sql`
              create table ${sql(tables)}.notes (
                id bigserial primary key,
                body text not null
              )
            `;

            const result = yield* asRole(role, (session) =>
              Effect.gen(function* () {
                const items = session`${session(tables)}.probe_items`;
                const notes = session`${session(tables)}.notes`;

                yield* session`insert into ${items} (label) values ('first')`;
                yield* session`update ${items} set label = 'renamed'`;

                const labels = yield* session<{
                  readonly label: string;
                }>`select label from ${items}`;

                yield* session`delete from ${items}`;

                const remaining = yield* session`select id from ${items}`;

                const note = yield* session<{ readonly id: bigint }>`
                  insert into ${notes} (body) values ('later') returning id
                `;

                yield* session`select lo_from_bytea(0, 'owned by the role')`;

                return { labels, remaining, note };
              }),
            );

            // A large object the role created leaves it safe to provision.
            yield* provisionRuntimeRole(role, tables);

            assert.deepStrictEqual(result.labels, [{ label: "renamed" }]);
            assert.lengthOf(result.remaining, 0);
            assert.deepStrictEqual(result.note, [{ id: 1n }]);
          }),
        ),
      ).pipe(withEmptyDatabase),
  );

  it.live(
    "keeps the role away from the schema, the journal and the server",
    () =>
      withRoleName((name) =>
        withMigrations(({ tables, journal }) =>
          Effect.gen(function* () {
            const sql = yield* ownerSql;
            const role = { name, password: Redacted.make("runtime-password") };

            // An existing role with more than it needs, which provisioning
            // takes back.
            yield* sql`
              create role ${sql(name)}
              with nologin createdb createrole replication bypassrls
            `;

            yield* provisionRuntimeRole(role, tables);

            const { owner } = firstRow(
              yield* sql<{ readonly owner: string }>`
                select current_user as owner
              `,
            );

            const refusals = yield* asRole(role, (session) => {
              const items = session`${session(tables)}.probe_items`;

              const attempts = {
                createTable: session`
                  create table ${session(tables)}.intruder (id integer)
                `,
                alterTable: session`
                  alter table ${items} add column intruder text
                `,
                dropTable: session`drop table ${items}`,
                truncate: session`truncate ${items}`,
                readJournal: session`
                  select * from ${session(journal)}.__drizzle_migrations
                `,
                createSchema: session`create schema intruder`,
                createRole: session`create role intruder`,
                becomeOwner: session`set role ${session(owner)}`,
                runProgram: session`copy (select 1) to program 'true'`,
              };

              return Effect.forEach(
                Object.entries(attempts),
                ([attempt, statement]) =>
                  statement.pipe(
                    Effect.flip,
                    Effect.map(
                      (error) => [attempt, sqlStateOf(error)] as const,
                    ),
                  ),
              ).pipe(Effect.map(Object.fromEntries));
            });

            // 42501: insufficient_privilege.
            assert.deepStrictEqual(refusals, {
              createTable: "42501",
              alterTable: "42501",
              dropTable: "42501",
              truncate: "42501",
              readJournal: "42501",
              createSchema: "42501",
              createRole: "42501",
              becomeOwner: "42501",
              runProgram: "42501",
            });

            const attributes = yield* sql`
              select
                rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls, rolinherit
              from pg_roles where rolname = ${name}
            `;

            assert.deepStrictEqual(attributes, [
              {
                rolcanlogin: true,
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                rolinherit: true,
              },
            ]);

            const memberships = yield* sql`
              select roleid from pg_auth_members
              where member = (select oid from pg_roles where rolname = ${name})
            `;

            assert.lengthOf(memberships, 0);
            assert.include(yield* tableNames(tables), "probe_items");
          }),
        ),
      ).pipe(withEmptyDatabase),
  );

  it.live("changes the password on every run", () =>
    withRoleName((name) =>
      withMigrations(({ tables }) =>
        Effect.gen(function* () {
          const first = { name, password: Redacted.make("first-password") };
          const second = { name, password: Redacted.make("second-password") };
          const ping = (sql: SqlClient.SqlClient) => sql`select 1`;

          yield* provisionRuntimeRole(first, tables);
          yield* asRole(first, ping);

          yield* provisionRuntimeRole(second, tables);
          yield* asRole(second, ping);

          const error = yield* asRole(first, ping).pipe(Effect.flip);

          // 28P01: invalid_password.
          assert.strictEqual(sqlStateOf(error), "28P01");
        }),
      ),
    ).pipe(withEmptyDatabase),
  );

  it.live("refuses the owner and an existing superuser, changing nothing", () =>
    withRoleName((name) =>
      withMigrations(({ tables }) =>
        Effect.gen(function* () {
          const sql = yield* ownerSql;
          const password = Redacted.make("runtime-password");

          const ownerBefore = firstRow(
            yield* sql<{ readonly name: string; readonly secret: string }>`
              select rolname as name, rolpassword as secret
              from pg_authid where rolname = current_user
            `,
          );

          const ownerRefusal = yield* provisionRuntimeRole(
            { name: ownerBefore.name, password },
            tables,
          ).pipe(Effect.flip);

          yield* sql`create role ${sql(name)} with superuser`;

          const superuserRefusal = yield* provisionRuntimeRole(
            { name, password },
            tables,
          ).pipe(Effect.flip);

          const roles = yield* sql`
            select rolname, rolsuper, rolcanlogin, rolpassword
            from pg_authid where rolname in (${ownerBefore.name}, ${name})
            order by rolname = ${name}
          `;

          assert.strictEqual(ownerRefusal._tag, "RuntimeRoleRefused");
          assert.match(ownerRefusal.message, /the role migrate connects as/);
          assert.strictEqual(superuserRefusal._tag, "RuntimeRoleRefused");
          assert.match(superuserRefusal.message, /an existing superuser/);

          assert.deepStrictEqual(roles, [
            {
              rolname: ownerBefore.name,
              rolsuper: true,
              rolcanlogin: true,
              rolpassword: ownerBefore.secret,
            },
            {
              rolname: name,
              rolsuper: true,
              rolcanlogin: false,
              rolpassword: null,
            },
          ]);
        }),
      ),
    ).pipe(withEmptyDatabase),
  );

  it.live("resets the settings the role gives itself", () =>
    withRoleName((name) =>
      withMigrations(({ tables }) =>
        Effect.gen(function* () {
          const sql = yield* ownerSql;
          const role = { name, password: Redacted.make("runtime-password") };
          const ping = (session: SqlClient.SqlClient) => session`select 1`;

          yield* provisionRuntimeRole(role, tables);

          yield* asRole(role, (session) =>
            Effect.gen(function* () {
              const [database] = yield* session<{ readonly name: string }>`
                select current_database() as name
              `;

              assert.isDefined(database);

              yield* session`
                alter role ${session(name)}
                in database ${session(database.name)}
                set default_transaction_read_only = on
              `;

              yield* session`
                alter role ${session(name)}
                set local_preload_libraries = 'missing_library'
              `;
            }),
          );

          // The missing library fails every new session of the role.
          yield* asRole(role, ping).pipe(Effect.flip);

          yield* provisionRuntimeRole(role, tables);

          const inserted = yield* asRole(
            role,
            (session) => session`
              insert into ${session(tables)}.probe_items (label)
              values ('first')
              returning label
            `,
          );

          const settings = yield* sql`
            select setconfig from pg_db_role_setting
            where setrole = (select oid from pg_roles where rolname = ${name})
          `;

          assert.deepStrictEqual(inserted, [{ label: "first" }]);
          assert.lengthOf(settings, 0);
        }),
      ),
    ).pipe(withEmptyDatabase),
  );

  it.live(
    "refuses a role that belongs to other roles or owns objects, changing nothing",
    () =>
      withRoleName((name) =>
        withMigrations(({ tables }) =>
          Effect.gen(function* () {
            const sql = yield* ownerSql;
            const role = { name, password: Redacted.make("runtime-password") };
            const items = sql`${sql(tables)}.probe_items`;

            const { owner } = firstRow(
              yield* sql<{ readonly owner: string }>`
                select current_user as owner
              `,
            );

            yield* sql`
              create role ${sql(name)} with login password 'existing-password'
            `;

            const roleState = sql`
              select rolpassword, rolcanlogin, rolcreatedb, rolcreaterole
              from pg_authid where rolname = ${name}
            `;

            const before = yield* roleState;

            // Each grants the role something it keeps whatever provisioning
            // changes, then takes it back.
            const cases = [
              {
                reason: /a member of other roles/,
                grant: sql`grant ${sql(owner)} to ${sql(name)}`,
                revoke: sql`revoke ${sql(owner)} from ${sql(name)}`,
              },
              {
                reason: /a member of other roles/,
                grant: sql`grant pg_execute_server_program to ${sql(name)}`,
                revoke: sql`revoke pg_execute_server_program from ${sql(name)}`,
              },
              {
                reason: /owns database objects/,
                grant: sql`alter table ${items} owner to ${sql(name)}`,
                revoke: sql`alter table ${items} owner to ${sql(owner)}`,
              },
            ];

            for (const { reason, grant, revoke } of cases) {
              yield* grant;

              const checked = yield* checkRuntimeRole(role).pipe(Effect.flip);

              const provisioned = yield* provisionRuntimeRole(
                role,
                tables,
              ).pipe(Effect.flip);

              assert.strictEqual(checked._tag, "RuntimeRoleRefused");
              assert.match(checked.message, reason);
              assert.strictEqual(provisioned._tag, "RuntimeRoleRefused");
              assert.match(provisioned.message, reason);
              assert.deepStrictEqual(yield* roleState, before);

              yield* revoke;
            }

            // With nothing left of those, the role is provisioned.
            yield* provisionRuntimeRole(role, tables);
            yield* asRole(role, (session) => session`select 1`);
          }),
        ),
      ).pipe(withEmptyDatabase),
  );

  it.live("stores a hostile password as it is and quotes a hostile name", () =>
    withRoleName((name) => {
      // Not a name the configuration accepts: this checks the SQL itself.
      const hostileName = `${name}"; drop table probe_items; --`;

      const role = {
        name: hostileName,
        password: Redacted.make(`it's"; drop table probe_items; -- $$ \\ %L`),
      };

      return withMigrations(({ tables }) =>
        Effect.gen(function* () {
          const sql = yield* ownerSql;

          yield* provisionRuntimeRole(role, tables);

          const items = yield* asRole(
            role,
            (session) => session`select id from ${session(tables)}.probe_items`,
          );

          const roles = yield* sql<{ readonly rolname: string }>`
            select rolname from pg_roles where rolname like ${`${name}%`}
          `;

          assert.lengthOf(items, 0);
          assert.deepStrictEqual(roles, [{ rolname: hostileName }]);
          assert.include(yield* tableNames(tables), "probe_items");
        }),
      ).pipe(Effect.ensuring(dropRole(hostileName)));
    }).pipe(withEmptyDatabase),
  );
});
