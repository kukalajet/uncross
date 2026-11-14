import { Config, Schema } from "effect";

// A lower-case PostgreSQL identifier that needs no quoting, at most 63 bytes
// (NAMEDATALEN - 1). Compose writes the name into the API's and the worker's
// database URL as it is, so it must need no percent-encoding either.
const roleNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;

// PostgreSQL reserves role names that start with `pg_` for its predefined
// roles, and `public` and `none`; CREATE ROLE rejects them.
const reservedRoleNamePattern = /^(?:pg_|(?:public|none)$)/;

const isUnreservedRoleName = Schema.makeFilter((name: string) => {
  const isReserved = reservedRoleNamePattern.test(name);

  if (isReserved) {
    return "Expected a role name PostgreSQL does not reserve: not public or none, and not starting with pg_";
  }

  return true;
});

const RoleName = Schema.String.check(
  Schema.isPattern(roleNamePattern),
  isUnreservedRoleName,
);

// The role the API and the worker connect as, which `migrate` provisions. Only
// `migrate` reads this, and it is not part of AppConfig, so the API and the
// worker never need the password on its own: they get the role's database URL.
const runtimeRoleConfig = Config.all({
  name: Config.schema(RoleName, "APP_DATABASE_USER"),
  password: Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "APP_DATABASE_PASSWORD",
  ),
});
type RuntimeRole = Readonly<Config.Success<typeof runtimeRoleConfig>>;

export { type RuntimeRole, runtimeRoleConfig };
