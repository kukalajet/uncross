# Uncross

A small exchange (order matching system) in TypeScript with Effect, shaped so
its performance-critical stages can later be rewritten in Rust without redesign.
[docs/DESIGN.md](./docs/DESIGN.md) records the design decisions and the reasons
behind them.

The workspace started from a backend template: Node.js 26, Effect 4, PostgreSQL
and Drizzle, with an HTTP API, a persistent worker, and a production deployment
to a single VPS behind Cloudflare Tunnel. The users feature and the polling job
are the template's examples, to be replaced by the exchange.

Node runs the TypeScript sources directly: there is no build step. Packages
follow dependency boundaries and application code is grouped by feature. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for code placement, Effect composition and
testing conventions, and [READABILITY.md](./READABILITY.md) for the code style
that lint cannot check.

## Prerequisites

- **pnpm 12**, installed standalone (see
  [pnpm's installation guide](https://pnpm.io/installation)). The repository
  pins pnpm's exact version in `packageManager` and `devEngines`, and pnpm
  switches to that version by itself. A Corepack shim from an older Node also
  works through `packageManager`; Node 26 itself ships without Corepack.
- **No separate Node install.** `devEngines.runtime` pins Node's exact version,
  and `pnpm install` downloads it into `node_modules`. Every `pnpm run` and
  `pnpm exec` uses that copy, whatever `node` your shell has.
- **Docker** with Compose, for PostgreSQL, the container stack, the static
  checks and the image scan.
- **Bash**, for the Docker smoke test, the static checks and the image scan,
  with curl for the smoke test and Git for the static checks.

## Getting started

```sh
cp .env.example .env
pnpm install
docker compose up -d --wait postgresql
pnpm db:migrate
```

- `pnpm install` links the workspace packages and installs the Git hooks.
- Keep real secrets out of committed files; `.env` is ignored by Git.

Then run the applications in separate terminals:

```sh
pnpm dev:api
pnpm dev:worker
```

Both load `.env` with `node --env-file` and restart when a source file changes.
The API listens on `http://127.0.0.1:8000`; open `/docs` for Swagger UI.

### Environment

| Variable                                            | Default            | Used by                                                                   |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `DATABASE_URL`                                      | required           | API, worker, migrations, Drizzle Kit, PostgreSQL tests                    |
| `DATABASE_STATEMENT_TIMEOUT_MS`                     | `10000`            | API and worker: PostgreSQL cancels a statement that runs longer (below)   |
| `API_HOST`                                          | `127.0.0.1`        | API                                                                       |
| `API_PORT`                                          | `8000`             | API; Compose also publishes the container API on it                       |
| `WORKER_POLL_INTERVAL_MS`                           | `5000`             | Worker: the pause after each pass of a job                                |
| `WORKER_PASS_TIMEOUT_MS`                            | `60000`            | Worker: a pass of a job that runs longer fails the worker                 |
| `LOG_LEVEL`                                         | `Info`             | API, worker and migrations: the lowest level logged ([Logs](#logs))       |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | see `.env.example` | Compose's PostgreSQL, and the database URL Compose gives `migrate`        |
| `APP_DATABASE_USER`, `APP_DATABASE_PASSWORD`        | see `.env.example` | `migrate`, which creates this role; Compose's API and worker log in as it |
| `POSTGRES_PORT`                                     | `5432`             | The loopback port Compose publishes PostgreSQL on                         |

`packages/config` validates the application variables; `DATABASE_URL` stays
redacted in logs. If you change `POSTGRES_PORT` or the credentials, change
`DATABASE_URL` in `.env` to match. Native commands all use that one owner URL,
so `pnpm dev:api` and `pnpm dev:worker` run as the owner, unlike the containers
(see [Database roles](#database-roles)).

## Application behavior

| Endpoint            | Purpose                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | Process liveness; never touches PostgreSQL                                                                          |
| `GET /health/ready` | PostgreSQL readiness (`select 1`, 5 second timeout); 503 when unavailable                                           |
| `GET /health`       | Alias for readiness                                                                                                 |
| `GET /users`        | Up to `limit` users (1–100, default 50), newest first; 400 for any other `limit`                                    |
| `GET /users/:id`    | One user; 400 for a malformed id, 404 when unknown                                                                  |
| `POST /users`       | 201 with the user; 400 for invalid input, 409 for a taken email, 413 > 4 KiB, 415 unless sent as `application/json` |
| `GET /openapi.json` | OpenAPI 3.1 document generated from the endpoint contracts                                                          |
| `GET /docs`         | Swagger UI for that document                                                                                        |

Every error response has the same shape, and the contract lists each code an
endpoint can return:

```json
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found" } }
```

Invalid path parameters, query strings, headers, malformed JSON, unknown fields
and a body whose text is not valid Unicode (bytes that are not UTF-8, or a lone
surrogate written as an escape such as `\ud800`) are `400 INVALID_REQUEST`. A
body that is not sent as `application/json`, with or without a `charset`
parameter, is `415 UNSUPPORTED_MEDIA_TYPE` whatever it holds: a browser can post
`text/plain`, or a body with no content type, to another site without a CORS
preflight. A failed database operation is `500 DATABASE_ERROR`; failed readiness
is `503 DATABASE_UNAVAILABLE`. Two codes belong to no endpoint: a request that
matches no route is `404 NOT_FOUND`, and a failure the API did not expect, a
defect, is `500 INTERNAL_ERROR`. Responses never carry the cause, and logs carry
only safe diagnostics such as a SQLSTATE code.

The API starts while the database is unavailable, because the connection pool
opens connections on demand. Liveness stays 200 during an outage; readiness and
user requests fail until PostgreSQL returns.

Database work has time limits. On the API's and the worker's connections
PostgreSQL cancels a statement after `DATABASE_STATEMENT_TIMEOUT_MS`
(SQLSTATE 57014) and a wait for a lock after 8 seconds (55P03), and ends a
session left idle inside a transaction for 30 seconds. A query waits at most 5
seconds for a pooled connection. PostgreSQL enforces its own limits, so none of
them fires when the server stops answering; each repository call therefore also
gives up by itself after the pool wait, the statement timeout and 2 seconds more
(17 seconds by default), and readiness after 5 seconds. The driver then waits up
to 5 seconds more for the server to confirm it cancelled the query, so a request
already sent on an open connection to a server that stopped answering fails
after 22 seconds by default, or 10 for readiness. That connection is then
dropped, and a request that has to open a new one fails within 5 seconds, when
connecting gives up. A statement, lock or pool timeout, or a call that gives up,
is a failed database operation: `500 DATABASE_ERROR`, or `503` for readiness,
logged with its safe diagnostics. A session ended for idling inside a
transaction takes its connection with it, so that transaction fails with a
defect instead, which the API answers with `500 INTERNAL_ERROR` and the worker
with a restart (see `packages/database/src/postgres.ts`).

`DATABASE_STATEMENT_TIMEOUT_MS` accepts 1 to 2147483647, PostgreSQL's limit.
Below 8000, a statement waiting for a lock is cancelled as a statement timeout
(57014) before its lock wait gives up, and below 5000, a query queued behind a
migration that waits for a lock fails before the migration gives up. Migrations
run on their own connection, without a statement timeout, and give up after
waiting 5 seconds for a lock.

The worker runs each job on its own loop, waiting `WORKER_POLL_INTERVAL_MS`
after each pass. The example job reads up to five users and logs how many it
found, at Debug. The first failure in any loop stops the worker with exit code
1, and the process supervisor (Compose's `restart: unless-stopped`) starts it
again. A pass that runs longer than `WORKER_PASS_TIMEOUT_MS` is interrupted, so
its open transaction never commits, and fails the worker the same way with a
`TimeoutError` naming the job; split work that needs longer into several passes.
If the pass is waiting on a database that has stopped answering, the driver
first takes up to 5 seconds to cancel the query, and SIGTERM waits as long. The
polling example provides no claims, leases, checkpoints or retries.

For one pass of every job, then exit. At the default level a pass that succeeds
writes nothing and exits 0, so these show the job's line with `LOG_LEVEL=Debug`,
which takes precedence over `.env`:

```sh
LOG_LEVEL=Debug pnpm sample:worker
# Or, with the container image built:
LOG_LEVEL=Debug docker compose run --rm worker-once
```

### Logs

The API, the worker and `migrate` write one JSON object per line to standard
output, through `LoggingLive` in `packages/config/src/logging.ts`. This is the
access line of an API request, spread over several lines here:

```json
{
  "message": "Sent HTTP response",
  "level": "INFO",
  "timestamp": "2026-10-28T07:41:29.080Z",
  "annotations": {
    "method": "GET",
    "path": "/users",
    "status": 200,
    "durationMs": 1,
    "cfRay": "8f1d2c3b4a5e6f70-FRA"
  },
  "spans": {},
  "fiberId": "#48",
  "traceId": "be603e828a153116646a9351644e029b",
  "spanId": "7c2538f6041fa617"
}
```

Every line has Effect's JSON fields: `message`, `level`, `timestamp`, `cause`
(only when there is one), `annotations`, `spans` and `fiberId`. While a span is
active, as during every API request and worker pass, it also has `traceId` and
`spanId`.

`LOG_LEVEL` sets the lowest level logged: `Info` by default, or `All`, `Trace`,
`Debug`, `Warn`, `Error`, `Fatal` or `None`, spelled exactly so. An empty value
means the default. `Debug` adds the worker job's line for each pass; `Fatal` and
`None` also silence failure reports. Any other value stops the process at
startup with exit code 1 and one `Invalid logging configuration` line that lists
the accepted values.

The API logs one access line per request, `Sent HTTP response`, after it sends
the response. Its annotations are `method`, `path`, `status`, `durationMs`, and
`cfRay` when the request carries Cloudflare's `cf-ray` header with a plain
value: up to 64 letters, digits and hyphens. Any client can send the header, so
another value is left out rather than logged.

- A 5xx response is logged at Error, anything else at Info. Clients and scanners
  cause 4xx responses all day, and none of them is a fault of the server.
- Only a 5xx line has a `cause`: the failure or defect behind it, with a
  persistence failure that is itself the failure or a defect reduced to its tag,
  operation and diagnostics, as the worker and `migrate` report theirs. Other
  defects keep their message and stack. A handled database failure
  (`500 DATABASE_ERROR`, `503 DATABASE_UNAVAILABLE`) has no cause on the access
  line; the handler logs its diagnostics on a line of its own with the same
  `traceId` and `spanId`.
- The path is logged without its query string or fragment, which can carry
  tokens or personal data. The client's address (behind the tunnel,
  cloudflared's), user agent and other headers are not logged either. Cloudflare
  may have them for a ray ID, depending on the plan: every plan can look up
  sampled security events, but a log of every request needs the Log Explorer
  add-on or Enterprise.
- `/health`, `/health/live` and `/health/ready` are logged only when they answer
  4xx or 5xx. The healthcheck calls liveness every 5 seconds in the local
  `docker-compose.yml` and every 10 in `deploy/vps/compose.yml`, 8,640 times a
  day, and `bin/release` polls readiness during a release.

A failure that stops a process is one Error line, `API failed`, `Worker failed`
or `Database migration failed`, with database failures reduced the same way.

**Following a request.** Each request runs in a span of its own, in a new trace
unless the request names one, so its access line and every line its handlers log
share a `traceId`. A client names the trace with a W3C `traceparent` or B3
header, so the trace ID is neither secret nor unique. In production the ray ID
is the one to start from: Cloudflare assigns it at the edge and returns it to
the client in the `cf-ray` response header. Ray IDs are not guaranteed to be
unique either, so check the line's timestamp. Find the request by its ray ID,
then everything it logged by its trace ID:

```sh
docker compose logs api | grep 8f1d2c3b4a5e6f70-FRA
docker compose logs api | grep be603e828a153116646a9351644e029b
```

Each worker pass runs in a trace of its own too.

**Before adding a trace exporter or error reporter.** Effect records spans even
without an exporter, and their exits hold raw causes: a server span whose
request failed with a 5xx ends with the cause, and every `Effect.fn` span, such
as `UserRepository.list`, with its error. OpenTelemetry exports those as
`exception` events whose `exception.message` and `exception.stacktrace` include
the whole `[cause]:` chain, so SQL, parameters and stored values would reach the
tracing backend. HttpApi and the HTTP server also pass raw causes to any
`ErrorReporter`. Log lines become span events too, but they carry the cause the
line logged, which the app has already reduced. The server span also records
what the access log leaves out on purpose: the full URL with its query string
(`url.full`, `url.query`), the user agent (`user_agent.original`) and the
client's address (`client.address`); Effect redacts only a few signing
parameters (`UrlParams.CurrentRedactedNames`). Reduce persistence failures with
`redactPersistenceFailures`, and drop or redact those attributes, before
anything leaves the process.

## Scripts

| Script                                | What it does                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm run init <name>`                | Renames the template (run once, first)                                                                |
| `pnpm dev:api`, `pnpm dev:worker`     | Runs the API or worker with `.env`, restarting on changes                                             |
| `pnpm start:api`, `pnpm start:worker` | Runs the API or worker with `.env`, without watching                                                  |
| `pnpm sample:worker`                  | Runs one pass of every worker job, then exits                                                         |
| `pnpm db:generate --name=<change>`    | Generates a migration in `drizzle/` from schema changes (Drizzle Kit)                                 |
| `pnpm db:check`                       | Prints Drizzle Kit's migration check; it exits 0 even when the schema differs                         |
| `pnpm db:verify`                      | Fails when the schema files and the migrations in `drizzle/` differ; part of `pnpm check`             |
| `pnpm db:migrate`                     | Applies pending migrations with `packages/database/src/migrate.ts`                                    |
| `pnpm db:studio`                      | Opens Drizzle Studio                                                                                  |
| `pnpm openapi`                        | Prints the OpenAPI document: `pnpm --silent openapi > openapi.json`                                   |
| `pnpm fmt`                            | Formats every file with oxfmt                                                                         |
| `pnpm lint`                           | Lints with oxlint                                                                                     |
| `pnpm fix`                            | Formats, then applies safe lint fixes                                                                 |
| `pnpm typecheck`                      | Type-checks with TypeScript's `tsc` and Effect's diagnostics (`scripts/typecheck.ts`)                 |
| `pnpm test`                           | Runs the unit tests                                                                                   |
| `pnpm test:postgres`                  | Runs the tests that need PostgreSQL                                                                   |
| `pnpm check`                          | Format check, lint, type check, migration drift check and unit tests: what CI and the image build run |
| `pnpm check:static`                   | shellcheck, actionlint and zizmor from pinned Docker images: what CI's `static` job runs              |
| `pnpm smoke:docker`                   | Smoke-tests a built image against a real PostgreSQL                                                   |
| `pnpm scan:image [image]`             | Scans a built image with Grype as CI does; the default image is `uncross:local`                       |

## Toolchain

- **TypeScript without a build.** Node 26 strips types when it loads a `.ts`
  file. That rules out syntax that needs code generation: relative imports end
  in `.ts`, type-only imports use `import type`, and there are no enums,
  namespaces, parameter properties or `<T>value` assertions. `tsconfig.json`
  turns on `erasableSyntaxOnly` and `verbatimModuleSyntax`, so `tsc` reports
  these constructs, value imports used only as types, and relative imports
  without an extension. `tsc` accepts a relative import ending in `.js`, though,
  and Node then fails to load it, so lint rejects one.
- **Vite+ (`vp`)** is the one CLI for formatting (oxfmt), linting (oxlint) and
  tests (Vitest 5). `vp check` checks formatting and lint; `vp check --fix`
  formats, then applies lint fixes. `vite.config.ts` loads the rules from
  `.oxlintrc.json` and `.oxfmtrc.json`, so editors and the standalone `oxlint`
  and `oxfmt` binaries apply the same rules. It also defines the `unit` and
  `postgres` test projects and the pre-commit `staged` command.
- **Lint** turns on oxlint's correctness category plus explicit rules, and the
  anti-slop rules in `tools/oxlint/anti-slop`: vendored from Ekze, plus
  `blank-line-around-multiline-statements` added here. Don't edit them to make
  code pass. They enforce import order, a trailing export list, a `SAFETY:`
  comment before every type assertion, blank lines before `return` and around
  multi-line blocks and statements, no nested ternaries, and no module mocking,
  among others. [READABILITY.md](./READABILITY.md) says which of its rules lint
  enforces.
- **Config-only lint guards** in `.oxlintrc.json` reject `console`,
  `process.env` (read `AppConfig`) and `Effect.run*` (run effects with
  `NodeRuntime.runMain` in an entry point) in `apps/` and `packages/`. They
  reject imports of `@uncross/database` and `effect/sql` in every folder under
  `apps/*/src/`, tests included; only the composition roots directly in `src/`
  may import them. Everywhere, they reject non-null assertions (`x!`),
  `{…} as T` object literal assertions and shadowed names. Tests,
  `*.postgres.ts`, `*.fixtures.ts` and `postgres.setup.ts` may use `console`,
  `process.env`, `Effect.run*` and `!`. The `Effect.run*` guard matches the call
  as written, so `import { runPromise } from "effect/Effect"` slips past it.
- **Formatting** follows `.oxfmtrc.json`: width 80, double quotes, semicolons,
  trailing commas, and Markdown prose wrapped at 80 columns. Import sorting is
  lint's job, in five groups: `node:` built-ins, packages, `@uncross/*`, `../`,
  then `./`.
- **Type checking** uses the single root `tsconfig.json` (strict,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and unused-code
  checks). `pnpm typecheck` runs TypeScript 7's `tsc` as `@effect/tsgo` builds
  it, with the Effect language service inside: `scripts/typecheck.ts` picks the
  build made from the installed `typescript`, and fails when there is none. Lint
  is not type-aware; the type check is the authoritative one.
- **Effect's diagnostics.** The type check also reports mistakes that plain
  `tsc` passes, such as an Effect that is built but never run, `yield` written
  for `yield*`, and an Effect returned to a plain Vitest `it`, which passes
  without running it. Errors and warnings fail it; suggestions are not shown.
  The `@effect/language-service` plugin in `tsconfig.json` configures them, with
  `unstableApiUsage` off: Effect 4 marks the HTTP, SQL, Node platform and Vitest
  modules the template is built on as unstable. Fix the code where you can; two
  `Effect.provide` calls in a row, for example, become one, with the layers
  merged or provided to each other. To accept a finding on one line, put
  `// @effect-diagnostics-next-line <rule>:off` on the line above, with a
  comment that says why; an unused directive fails the check.
  `scripts/typecheck.test.ts` type-checks a fixture with each of the three
  mistakes above and fails unless each is an error, so a renamed plugin entry or
  an option that turns them off cannot pass silently. Editors show the same
  errors (see [Editor](#editor)).
- **Git hooks.** `pnpm install` runs `prepare`, whose `vp config --no-agent`
  points Git's `core.hooksPath` at the dispatcher in `.vite-hooks/_`. The hooks
  themselves are `.vite-hooks/pre-commit` and `.vite-hooks/pre-push`. Before a
  commit, `vp staged` formats and lints the staged files; before a push, the
  hook runs the type check and unit tests. `pnpm exec vp hooks disable` turns
  them off for a clone, and `VP_GIT_HOOKS=0` skips both installing and running
  them.

## Testing

- **`pnpm test`** runs every `*.test.ts` under `apps/`, `packages/` and
  `scripts/`. These need no database or network. They use `@effect/vitest`
  (`it.effect`, and `TestClock` from `effect/testing`) and replace services with
  layers; module mocking fails lint. API tests check every response against the
  endpoint contract, and the served OpenAPI document against the one generated
  from the code. Database adapter tests run the real Drizzle queries against a
  fake PostgreSQL client.
- **`pnpm test:postgres`** runs every `*.postgres.ts` under `apps/` and
  `packages/`, one file at a time, against a real PostgreSQL. Each test creates
  a schema with a random name, applies the migrations in `drizzle/`, and drops
  the schema afterwards. It needs `DATABASE_URL`, from the environment or
  `.env`, for a superuser, because the runtime role tests create and drop roles;
  with the local stack, `docker compose up -d --wait postgresql` is enough. It
  is not part of `pnpm check`; CI runs it as its own job.

## Database schema and migrations

```sh
pnpm db:generate --name=describe-change
pnpm db:verify
pnpm db:migrate
pnpm db:studio
```

Drizzle Kit generates migrations from the table definitions in every
`packages/database/src/<feature>/schema.ts` (the `schema` glob in
`drizzle.config.ts`), so a new feature's table file needs no config change. It
reads `.env` itself. Commit each generated `drizzle/<timestamp>_<name>/` folder.

`pnpm db:verify`, which `pnpm check` also runs, fails when a schema change has
no migration, including an index or constraint that no test would notice.
Drizzle Kit's own `check` reports that only as a warning and exits 0. The
verification reads files only and needs no database or `DATABASE_URL`.

`pnpm db:migrate`, the Compose `migrate` service and production releases all run
`packages/database/src/migrate.ts`. It applies pending migrations in one
transaction and records them in `drizzle.__drizzle_migrations`, the same journal
Drizzle Kit uses, so either tool skips what the other applied. Neither
application migrates at startup.

### Database roles

Two PostgreSQL roles share the database. `migrate` connects as the owner,
`POSTGRES_USER`, which the PostgreSQL image makes a superuser. The API and the
worker in Compose and in production connect as the runtime role,
`APP_DATABASE_USER`. It may read, insert, update and delete rows in the tables
of the `public` schema and use their sequences. It is no superuser and belongs
to no other role, so it cannot create, alter, drop or truncate those tables,
create schemas or roles, read the migration journal in `drizzle`, read or write
server files, or run programs on the server with `COPY ... TO PROGRAM`. SQL
injection therefore reaches the application's rows, not the schema or a shell
next to the data volume.

The role keeps what PostgreSQL grants every role: it can connect to the
cluster's other databases, without creating anything there; create temporary
tables and functions, which last as long as its session; create large objects;
call functions open to everyone; and change its own password and session
defaults. Every `migrate` run sets the password and resets those defaults.

After applying the migrations, every `migrate` run creates the runtime role or
updates it (`packages/database/src/runtime-role.ts`): it sets its attributes and
its password from `APP_DATABASE_PASSWORD`, so changing the password and running
`migrate` again rotates it, clears settings stored for the role, and grants it
access to every table in `public`, including tables the owner creates later. The
password reaches PostgreSQL only as a salted SCRAM-SHA-256 hash. A table in
another schema needs its own grants, in the migration that creates it.

`APP_DATABASE_USER` is lowercase letters, digits and `_`, does not start with a
digit, has at most 63 characters, and is not `public`, `none` or a name starting
with `pg_`. Name a role no other client uses: before it changes anything,
`migrate` fails when the name is the owner or an existing role that is a
superuser, belongs to another role, or owns database objects. Renaming the role
later leaves the old one able to log in with its old grants; once the release
with the new name serves, remove it as the owner with
`REASSIGN OWNED BY <old> TO CURRENT_USER; DROP OWNED BY <old>; DROP ROLE <old>;`.

## Local container stack

The default Compose setup runs only PostgreSQL, published on
`127.0.0.1:${POSTGRES_PORT:-5432}` by `docker-compose.override.yml` for native
commands. For the complete stack:

```sh
docker compose --profile app up -d --build --wait
docker compose logs -f api worker
```

The worker logs its passes at Debug; set `LOG_LEVEL=Debug` in `.env`, or prefix
the `up` command with it, to see them.

The image build runs `pnpm check`. Compose waits for PostgreSQL, runs `migrate`,
then starts the API and worker. `migrate` gets a database URL built from
`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, and the API and worker
one built from `APP_DATABASE_USER`, `APP_DATABASE_PASSWORD` and `POSTGRES_DB`,
so use URL-safe credentials. The API is published on
`127.0.0.1:${API_PORT:-8000}`; do not run the native and container APIs on the
same port. Rebuild with the same command after changes. To apply new migrations
through the image, rebuild it and run `docker compose run --rm migrate`.

Every container has a read-only root filesystem, no Linux capabilities and
`no-new-privileges`. The application containers can write only to a 16 MB `/tmp`
and run at most 128 processes and threads. PostgreSQL starts as the image's
`postgres` user and writes only to its volume, `/var/run/postgresql` and `/tmp`.
Code that writes files must use `/tmp` or a volume.

Database data survives container recreation and `docker compose down`; adding
`--volumes` deletes it.

### Docker image

The `Dockerfile` builds one image for the API (its default command), the worker,
the one-shot worker and migrations:

- A `check` stage installs every dependency and runs `pnpm check`. The runtime
  stage depends on it, so code that fails the checks never becomes an image.
- The runtime stage installs production dependencies only and runs as the
  image's non-root `node` user. The build fails if the base image's Node version
  differs from `devEngines.runtime`.
- The runtime stage deletes npm and npx, which nothing in it runs. npm's bundled
  dependencies are where scanners find most of the base image's fixable
  vulnerabilities. The base layers still hold the files, so the image is no
  smaller.
- `node` is PID 1 (`CMD ["node", "apps/api/src/main.ts"]`), so it receives stop
  signals directly. Never start a container through `pnpm`, which does not pass
  signals on to Node.
- The image also carries `deploy/vps` as `/app/deploy/vps`, from which the
  server's release script installs `compose.yml` and `bin/`. The `check` stage
  leaves `deploy/` out, so a deployment-only change does not rerun the checks.

### Smoke test

```sh
docker build -t uncross:local .
pnpm smoke:docker
```

`scripts/smoke-docker.sh` starts the image in an isolated Compose project with a
fresh database. It checks liveness and readiness, runs `scripts/smoke-api.ts`
inside the API container (every endpoint, error status and the OpenAPI and docs
pages), and runs `worker-once` and `migrate` again. It checks that a request's
access line has its `cf-ray` and a trace ID but not its query string, and that
neither passing health probes nor Effect's own HTTP logger's lines appear. It
checks that the worker has completed a pass without restarting and that the API
and worker are connected as the runtime role, not a superuser, then stops
PostgreSQL to check that liveness stays up, readiness returns 503 and is logged
at Error, and the worker restarts. Finally it restores the database and checks
that the data and migration history survived and that the worker completes a
pass again. It runs the stack with `LOG_LEVEL=Debug`, because it reads the
worker's line for each pass. It removes only its own containers and volume.

`scripts/smoke-api.ts` creates `ada@example.com` and expects to find her alone,
so run it only against a freshly migrated database, never production.

## Continuous integration

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on pull requests,
cancelling superseded runs. On `main` it runs once per push, as the first stage
of the Release workflow, which calls it as a reusable workflow, so every job
below also gates releases. It has four jobs:

| Job        | What it runs                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| `check`    | `pnpm install --frozen-lockfile`, then `pnpm check`                            |
| `static`   | `pnpm check:static`: shellcheck, actionlint and zizmor                         |
| `smoke`    | Builds the image (which runs `pnpm check` again), the smoke test, a Grype scan |
| `postgres` | `pnpm test:postgres` against a PostgreSQL service container                    |

Every action is pinned to a commit SHA. Protect `main` with a ruleset that
requires the `check`, `static`, `smoke` and `postgres` checks; the
[VPS guide](./deploy/vps/README.md#7-github) has the settings. If you delete
`release.yml`, add `push: { branches: [main] }` to `ci.yml`'s triggers so `main`
keeps its CI.

### Static checks

`pnpm check:static` runs [`scripts/check-static.sh`](./scripts/check-static.sh),
the same script as CI's `static` job. Its three tools run from Docker images
pinned by digest, so it needs Docker and is not part of `pnpm check`, which the
image build also runs.

- **shellcheck** checks every shell script: each tracked or new, unignored file
  that ends in `.sh` or starts with a sh or bash shebang, and the Git hooks in
  `.vite-hooks`, which a `# shellcheck shell=sh` directive marks.
- **actionlint** checks the workflows, and the scripts in their `run:` steps
  with the shellcheck in its image. It ignores one error, the `queue` key in
  `release.yml` (see [Caveats](#caveats)).
- **zizmor** audits the workflows for security problems. With `GH_TOKEN` set, it
  also runs its online audits (impostor commits, known vulnerable actions), as
  CI does with the job's read-only token; without it, only the offline audits
  run. Fix a finding, or accept it with an inline
  `# zizmor: ignore[<audit>] <reason>` comment and the full reason above it, as
  `release.yml` does for its call of `ci.yml`.

### Image scan

After the smoke test, the `smoke` job scans the image with Grype through
`anchore/scan-action`, which installs the Grype version that `grype-version`
pins. The scan fails on High and Critical vulnerabilities that have a fix, and
its log lists every fixable one. [`scan.yml`](./.github/workflows/scan.yml) runs
the same scan every Monday, and on manual dispatch, on an image it builds from
`main`, so a vulnerability published after the last merge does not wait for the
next pull request. In a public repository GitHub disables a scheduled workflow
after 60 days without activity; enable it again on the Actions tab.

A newly published vulnerability can fail an unrelated pull request. Fix it
first: update the dependency, or re-pin the `Dockerfile`'s base image to its
tag's current digest. Accept a finding only when it cannot affect the image,
with an `ignore` rule in [`.grype.yaml`](./.grype.yaml) that names the
vulnerability, the package version and a dated reason; the file has an example.

To reproduce the scan on a local build, run `pnpm scan:image` after
`docker build -t uncross:local .`, or pass another image's name.
[`scripts/scan-image.sh`](./scripts/scan-image.sh) runs the Grype version that
`grype-version` pins, from an image pinned by digest, with the same settings.
Grype reads a saved copy of the image, not the Docker socket, and downloads the
current vulnerability database on each run.

## Deployment

Production is one x86-64 Linux VPS running the Docker Compose project in
[`deploy/vps/`](./deploy/vps/). Cloudflare Tunnel is the only ingress, and
nightly encrypted backups go to S3-compatible storage with restic. A weekly
check restores the latest backup, and the backup, that check and a check of the
host and services every 5 minutes each report to a dead man's switch. There is
one environment; local development and CI are the checks before production.

Every push to `main` starts
[the Release workflow](./.github/workflows/release.yml), which also runs on
manual dispatch. It runs the whole CI first, including the PostgreSQL tests. Its
`publish` job then builds the image without the Actions build cache, which any
job on `main` can write to, smoke-tests it, labels it with the commit and pushes
it to GitHub Container Registry tagged with the commit SHA. Its `deploy` job,
the only one that holds the server's SSH key, sends the SHA and the pushed
image's digest to the server, whose `bin/release` takes everything else from
that image. The release script pulls the image by digest and checks its commit
label, migrates once, restarts the API, worker and tunnel, and checks that the
API is ready, the tunnel is connected and the worker and tunnel stay up. When a
check fails, it restores the previous release on its own and fails. See
[the VPS guide](./deploy/vps/README.md) for server setup, secrets, rollback,
backups, the weekly restore check and alerting.

The `publish` and `deploy` jobs run only when the repository variable
`PRODUCTION_HOST` is set, so until the server exists, pushes to `main` run CI
only. If you deploy another way, delete `release.yml` and give `ci.yml` its push
trigger back (see above).

## Editor

Editors type-check with the project's own TypeScript, as the Effect build that
`pnpm typecheck` runs, so they show the errors the check reports, Effect's
diagnostics included, and no others. `prepare`, which `pnpm install` runs, has
`effect-tsgo patch` put that build in place of the installed `typescript`
package's `tsc`, keeping the original as `tsc.original`. When `@effect/tsgo` has
no build for the installed TypeScript, as after updating only one of the two,
the patch fails `pnpm install` and lists the versions it supports. pnpm skips
`prepare` when nothing changed, so in a clone installed before this setup, or
after `pnpm install --ignore-scripts`, run `pnpm prepare` once; the toolchain
test fails until you do.

- **Zed:** install the `TypeScript Language Server` (`tsgo`) and `oxc`
  extensions; project settings cannot install extensions. `.zed/settings.json`
  runs `node_modules/.bin/tsc --lsp --stdio` as the tsgo extension's server in
  place of vtsls, and Zed asks you to trust the project before it starts a
  server from it. The oxlint language server fixes as you type and oxfmt formats
  on save. `.zed/debug.json` has debug configurations for the API, the worker
  and the current Vitest file. All three use the pinned Node in
  `node_modules/.bin/node`; the API and worker load `.env`.
- **VS Code:** install the recommended extensions, TypeScript 7 and Oxc.
  `.vscode/settings.json` points TypeScript 7 at `node_modules/typescript`, as
  `effect-tsgo setup --vscode` does, and formats with oxfmt and then applies
  oxlint's safe fixes on save.

## Exact dependency policy

Every version is exact; there are no ranges. Renovate keeps them current, so
this README names no exact versions; read them where they are pinned:

| File                                                     | Pins                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                           | Node (`devEngines.runtime`), pnpm (`packageManager`, `devEngines.packageManager`) and the root `devDependencies`            |
| `pnpm-workspace.yaml`                                    | The `catalog` of dependencies the workspace packages share, such as Effect and Drizzle, and the Vite and Vitest `overrides` |
| `Dockerfile`                                             | The Node base image by digest, the pnpm it installs, and the Dockerfile syntax image                                        |
| `docker-compose.yml`, `deploy/vps/compose.yml`, `ci.yml` | PostgreSQL by digest, and in `deploy/vps/compose.yml` `cloudflared`                                                         |
| `scripts/check-static.sh`, `scripts/scan-image.sh`       | The shellcheck, actionlint, zizmor and Grype images by digest                                                               |
| `.github/workflows/*.yml`                                | Every action by commit SHA, and in `ci.yml` and `scan.yml` the Grype version (`grype-version`)                              |

Dependencies shared by workspace packages are declared once in the `catalog` and
referenced as `catalog:`; workspace packages depend on each other with
`workspace:*`. The four Effect packages share one version, as do Drizzle ORM and
Kit. The lockfile is committed, so indirect resolution is reproducible.

pnpm 12 does not resolve a version published less than a day ago unless you name
it exactly. With `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`, it also
refuses a version published with weaker evidence than an earlier version of the
same package, such as without the provenance or trusted publishing its earlier
releases had, which is how a release from a stolen npm token looks. If you have
checked such a version and trust it, list it in `trustPolicyExclude`.

### Dependency updates

[Renovate](https://docs.renovatebot.com/), configured in
[`renovate.json5`](./renovate.json5), opens a pull request for every pin above,
and for the lockfile once a week. Install the
[Renovate GitHub App](https://github.com/apps/renovate) on the repository; this
is a manual step for its owner, and it needs Issues turned on for the Dependency
Dashboard. Because the configuration already exists, Renovate skips its
onboarding pull request.

- **Dependency Dashboard.** An issue that Renovate keeps current: every
  dependency it found, the updates it is waiting for, and checkboxes that open
  or rebase a pull request on demand.
- **Three days.** Renovate proposes a release once it is three days old, so a
  broken or hijacked release has time to be reported and pulled. Where it cannot
  read a release date, it holds the update under "Pending Status Checks" on the
  dashboard until you check the date and tick it: zizmor, because GHCR publishes
  no dates, and `postgres` and `cloudflared`, whose Docker Hub tag lists are too
  long to read without signing in
  ([renovatebot/renovate#46925](https://github.com/renovatebot/renovate/issues/46925)).
  Renovate offers that tick only when every update in a pull request is held,
  and otherwise leaves the held one out, so each of these images has a group of
  its own. A ticked update's pull request keeps a pending
  `renovate/stability-days` status, which is not a required check.
- **Images that follow a pin.** The `Dockerfile`'s `node` image and the Grype
  image in `scripts/scan-image.sh` have no dates either, but repeat a dated
  version: `devEngines.runtime`, which nodejs.org dates, and `grype-version`,
  which its GitHub release dates. Their version updates wait for that pin's
  three days, and the pull request opens only once it updates every place. Until
  then the dashboard lists it under "Group Size Not Met"; a tick there opens it
  early, failing the toolchain test until the rest arrives. A new digest of the
  same `node` tag, a rebuilt base image, waits for a tick like `postgres`.
- **What the three days do not cover:**
  - **Actions.** An action's release date is its tag's or commit's, which
    whoever pushes the tag sets, or its GitHub Release's when that is later.
    Before merging an action update, check that the version has a GitHub Release
    and when it was published; the pull request reminds you.
  - **Moved action tags.** An update that keeps an action's version but moves it
    to another commit means its tag was moved, as in a hijacked release, and
    Renovate would date it by the original release. It waits under "Pending
    Approval" on the dashboard instead, each in a pull request of its own;
    approve it only once you have confirmed the maintainers moved the tag.
  - **The weekly lockfile pull request.** pnpm re-resolves indirect dependencies
    for it with its own minimum release age of one day (see above).
  - **Security fixes.** With Dependabot alerts on, Renovate opens a pull request
    for a vulnerable dependency's fix at once, without the wait.
- **One pull request per group,** and nothing merges by itself; every pull
  request runs CI.

| Group              | What it updates                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Effect             | `effect` and `@effect/*` in the catalog                                                                            |
| Drizzle            | `drizzle-orm` and `drizzle-kit`, without Drizzle's branch builds                                                   |
| Vite+ toolchain    | `vite-plus`, `oxlint`, `oxfmt`, `@oxlint/plugins` and `vitest`, and the Vite and Vitest overrides, majors included |
| TypeScript         | `typescript` and `@effect/tsgo`, without TypeScript's nightly builds, majors included                              |
| Node               | `devEngines.runtime` and the `Dockerfile`'s base image; the workflows read Node from `package.json`                |
| pnpm               | `packageManager`, `devEngines.packageManager` and the `Dockerfile`'s `npm install --global pnpm@…`                 |
| PostgreSQL         | Minor versions and digests in `ci.yml` and both Compose files                                                      |
| cloudflared        | `deploy/vps/compose.yml`                                                                                           |
| GitHub Actions     | Every action in the workflows, except moved tags                                                                   |
| Static check tools | The shellcheck and actionlint images in `scripts/check-static.sh`                                                  |
| zizmor             | The zizmor image in `scripts/check-static.sh`                                                                      |
| Grype              | `grype-version` in `ci.yml` and `scan.yml`, and the image in `scripts/scan-image.sh`                               |

Anything else, such as `@types/node`, `pg` or the Dockerfile syntax image, gets
a pull request of its own. PostgreSQL major versions are left out: a new major
needs a dump and restore of the production database, so plan it by hand (see the
[VPS guide](./deploy/vps/README.md)).

[`scripts/toolchain.test.ts`](./scripts/toolchain.test.ts), part of
`pnpm check`, fails a pull request that updates only some places of a pin that
appears in several: Node in `devEngines.runtime` and the `Dockerfile`; pnpm in
`packageManager`, `devEngines.packageManager` and the `Dockerfile`; each Docker
image in every file that names it; the scan in `ci.yml` and `scan.yml`, and its
Grype version in `scripts/scan-image.sh`; and the oxlint, oxfmt,
`@oxlint/plugins`, Vitest and Vite versions that the installed `vite-plus` pins.
oxc and Vitest often release before Vite+ pins the release, so the Vite+ group
can fail that test until Renovate adds the `vite-plus` release that pins them;
wait for it. It also runs the type check's `tsc` and fails unless it is the one
`@effect/tsgo` builds from the pinned `typescript`, at the pinned
`@effect/tsgo`. Each `@effect/tsgo` release ships builds for specific TypeScript
releases, so a TypeScript update fails `pnpm check` at the type check, before
the tests run, until the TypeScript group also carries an `@effect/tsgo`
release, three days old, that ships it. The type check then prints "No packaged
Effect TypeScript executable matches installed TypeScript …" and what to do.

Renovate does not manage the image built from this repository (`uncross:local`
and the commit-tagged release images), the `ubuntu-latest` runners, the Grype
vulnerability database (each scan downloads the current one), or the Debian
packages inside the base images, which arrive with a new base image digest.

## Prerelease notes

- **Drizzle 1.0** is a release candidate. From rc.5 on it works with stable
  Effect 4 (`Schema.TaggedError`, `effect/sql`), so no patch is needed.
  `migrate.ts` uses its Effect migrator, `drizzle-orm/effect-postgres/migrator`.
- **TypeScript 7**, the Go-native compiler, is pinned to a prerelease. Drizzle's
  declaration files do not type-check under it, so `skipLibCheck` must stay on.
- **`@effect/tsgo`**, which runs the type check, is a 0.x third-party build of
  TypeScript 7's compiler, patched with the Effect language service, and is
  released several times a week. Its package for your platform is roughly 200 MB
  unpacked, and grows with the TypeScript builds each release ships. The image
  build's check stage and CI's `check` and `postgres` jobs install it too; the
  runtime image does not contain it.
- **Vite+** bundles Vitest. The `overrides` in `pnpm-workspace.yaml` keep one
  Vite (`vite-plus-core`) and one Vitest, so `vp test` and `@effect/vitest`
  share a runner. `scripts/toolchain.test.ts` fails when they, or the root
  oxlint, oxfmt and `@oxlint/plugins`, differ from what the installed
  `vite-plus` pins.
- **`@effect/platform-node`** declares `redis` as a required peer, although only
  its Redis module uses it; `packageExtensions` marks it optional.

## Caveats

- npm and npx refuse to run inside the repository (`EBADDEVENGINES`), because
  `devEngines` names pnpm. Use `pnpm exec` and `pnpm dlx`.
- A bare `node` in your shell is whatever is on your `PATH`, not the pinned
  version. Use `pnpm exec node` or a `pnpm` script.
- Signalling a `pnpm` process does not stop the Node process it started. Ctrl+C
  in a terminal signals both; process managers and containers must run `node`
  directly.
- `pnpm install` prints "Agent skills awaiting approval: drizzle-kit". It is a
  pnpm 12 notice; `pnpm approve` reviews it, and nothing else depends on it.
- Spans hold unredacted causes and full URLs. Read [Logs](#logs) before adding a
  trace exporter or an `ErrorReporter`.
- A failed migration logs its safe diagnostics, such as the SQLSTATE code
  (`42P07`), but not PostgreSQL's message, which can contain stored values. Look
  up the code, or run the migration's SQL by hand against a local database.
- As of 1.7.12, `actionlint` reports the `queue` key under `concurrency` in
  `release.yml` as unknown. GitHub accepts it, so `scripts/check-static.sh`
  ignores that error; remove the ignore once actionlint knows the key, for
  example when reviewing Renovate's update of it.
