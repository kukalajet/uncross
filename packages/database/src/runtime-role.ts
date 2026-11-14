import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { RuntimeRole } from "@node-effect/config";

class RuntimeRoleRefused extends Schema.TaggedError<RuntimeRoleRefused>()(
  "RuntimeRoleRefused",
  { message: Schema.String },
) {}

// PostgreSQL's defaults for a new SCRAM-SHA-256 secret: `scram_iterations`
// and the salt length in src/include/common/scram-common.h. The salted password
// is as long as a SHA-256 digest (RFC 7677).
const scramIterations = 4096;
const scramSaltBytes = 16;
const scramKeyBytes = 32;

// The SCRAM-SHA-256 secret PostgreSQL would store for `password`, in its
// `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` form (RFC 5802).
// CREATE and ALTER ROLE store a secret in this form as they receive it, which
// is what psql's \password relies on, so the password itself never reaches
// the server, its logs or its error messages. Like @effect/sql-pg when it logs
// in, this skips SASLprep, which changes only non-ASCII passwords.
const scramSecret = (password: string) => {
  const salt = randomBytes(scramSaltBytes);

  const saltedPassword = pbkdf2Sync(
    password,
    salt,
    scramIterations,
    scramKeyBytes,
    "sha256",
  );

  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key")
    .digest();

  const storedKey = createHash("sha256").update(clientKey).digest("base64");

  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key")
    .digest("base64");

  return `SCRAM-SHA-256$${scramIterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
};

// CREATE ROLE, ALTER ROLE and GRANT take no bind parameters, so the role's
// name, its secret and the schema arrive as bind parameters into settings that
// last until the transaction ends, and format() quotes each where it is used:
// %I as an identifier, %L as a literal. No value is spliced into the SQL this
// client sends.
//
// The password is set on every run, so changing APP_DATABASE_PASSWORD and
// running `migrate` rotates it. The attributes are set and the role's stored
// settings cleared on every run too. The role can change its settings itself
// (`alter role ... set`), and one such as `default_transaction_read_only` or
// an unloadable `local_preload_libraries` would otherwise break the API and
// the worker across every later release. The default privileges cover tables
// and sequences the owner creates later, such as with `drizzle-kit migrate`.
const provisionStatement = `
  do $$
  declare
    role_name constant text := current_setting('runtime_role.name');
    role_secret constant text := current_setting('runtime_role.secret');
    table_schema constant text := current_setting('runtime_role.schema');
    attributes constant text :=
      'login nosuperuser nocreatedb nocreaterole noreplication nobypassrls';
    owner_defaults constant text := format(
      'alter default privileges for role %I in schema %I',
      current_user, table_schema);
  begin
    if exists (select from pg_roles where rolname = role_name) then
      execute format('alter role %I with %s password %L',
        role_name, attributes, role_secret);
    else
      execute format('create role %I with %s password %L',
        role_name, attributes, role_secret);
    end if;

    execute format('alter role %I reset all', role_name);
    execute format('alter role %I in database %I reset all',
      role_name, current_database());

    execute format('grant usage on schema %I to %I', table_schema, role_name);
    execute format(
      'grant select, insert, update, delete on all tables in schema %I to %I',
      table_schema, role_name);
    execute format(
      'grant usage, select on all sequences in schema %I to %I',
      table_schema, role_name);
    execute format(
      '%s grant select, insert, update, delete on tables to %I',
      owner_defaults, role_name);
    execute format(
      '%s grant usage, select on sequences to %I',
      owner_defaults, role_name);
  end
  $$
`;

type ExistingRole = {
  readonly is_owner: boolean;
  readonly is_superuser: boolean;
  readonly is_member: boolean;
  readonly owns_objects: boolean;
};

// What would make provisioning an existing role unsafe, in the order it is
// reported: the owner, whose privileges provisioning would take away; a
// superuser, which something else may rely on; a member of another role, which
// keeps that role's privileges, such as a shell through
// pg_execute_server_program or the owner's through SET ROLE; and the owner of
// objects, which it could alter or drop. A role `migrate` provisioned cannot
// give itself any of these, so each means the name belongs to someone else.
// Large objects are the exception and are left out: any role may create one,
// the API through an injected `lo_from_bytea` too, and one grants access to
// itself only. A temporary table counts as well, while the session that
// created it lasts; the API and the worker create none.
const findExistingRole = (sql: SqlClient.SqlClient, name: string) =>
  sql<ExistingRole>`
    select
      rolname = current_user as is_owner,
      rolsuper as is_superuser,
      exists (
        select from pg_auth_members where member = role.oid
      ) as is_member,
      exists (
        select from pg_shdepend
        where refclassid = 'pg_authid'::regclass
          and refobjid = role.oid
          and deptype = 'o'
          and classid <> 'pg_largeobject'::regclass
      ) as owns_objects
    from pg_roles as role
    where rolname = ${name}
  `;

const refusalReason = (name: string, existing: ExistingRole) => {
  if (existing.is_owner) {
    return `APP_DATABASE_USER ${name} is the role migrate connects as; the API and the worker need a role of their own`;
  }

  if (existing.is_superuser) {
    return `APP_DATABASE_USER ${name} is an existing superuser; choose a name no other client uses`;
  }

  if (existing.is_member) {
    return `APP_DATABASE_USER ${name} is a member of other roles, whose privileges it would keep; choose a name no other client uses`;
  }

  if (existing.owns_objects) {
    return `APP_DATABASE_USER ${name} owns database objects, which it could alter or drop; choose a name no other client uses`;
  }

  return undefined;
};

const refuseUnsafeRole = (sql: SqlClient.SqlClient, name: string) =>
  Effect.gen(function* () {
    // No row: the role does not exist yet, and provisioning creates it.
    const [existing] = yield* findExistingRole(sql, name);
    if (existing === undefined) return;

    const reason = refusalReason(name, existing);
    if (reason === undefined) return;

    return yield* new RuntimeRoleRefused({ message: reason });
  });

// Fails with RuntimeRoleRefused when provisioning `role` would be unsafe (see
// findExistingRole), and changes nothing either way. `migrate` runs it before
// the migrations, so a refused release applies nothing.
const checkRuntimeRole = (role: RuntimeRole) =>
  SqlClient.SqlClient.use((sql) => refuseUnsafeRole(sql, role.name));

// Creates or updates `role` as a login role that can only read and write the
// tables in `schema`, the one the migrations create their tables in. Runs as
// the owner that applied them, after their transaction has committed, so the
// grants see every table. The role gets no access to the migrations' journal
// in the `drizzle` schema, nor to tables in any other schema.
//
// Checks the role again inside its transaction, and fails without changing
// anything when checkRuntimeRole would.
const provisionRuntimeRole = (role: RuntimeRole, schema = "public") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* refuseUnsafeRole(sql, role.name);

        const secret = scramSecret(Redacted.value(role.password));

        yield* sql`
          select
            set_config('runtime_role.name', ${role.name}, true),
            set_config('runtime_role.secret', ${secret}, true),
            set_config('runtime_role.schema', ${schema}, true)
        `;

        yield* sql.unsafe(provisionStatement);
      }),
    );
  });

export { checkRuntimeRole, provisionRuntimeRole, RuntimeRoleRefused };
