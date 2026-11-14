# Architecture and code placement

This workspace is organized by **architectural boundary** at the package level
and by **feature** inside each application. The goal is to make dependencies
visible: application code declares what it needs, adapters implement those
contracts, and each executable chooses the concrete implementations in its
composition root.

## Dependency direction

Arrows mean "may import":

```text
API routes -----------+
                      +--> application --> domain
worker jobs ----------+

database adapters --------> application + domain
database infrastructure --> config

app composition roots --> routes or jobs + database + config
```

The rules behind the diagram are more important than the exact folders:

- `domain` has no dependency on another workspace package. It owns business
  values, entities, invariants, and domain errors.
- `application` depends on `domain`. It owns use cases and contracts (ports)
  such as `UserRepository`, and the shared `PersistenceFailure` error fields,
  but no PostgreSQL, HTTP, or Node runtime code.
- `database` is an outbound adapter. It depends on application contracts and
  domain types, and owns PostgreSQL, Drizzle, tables, row mappings, live
  repository implementations, and the migration entry point.
- `config` owns validated environment configuration, and `LoggingLive`, the
  logging every entry point provides, which `LOG_LEVEL` configures. It lives
  here because every executable, `migrate` included, already depends on
  `config`, which depends only on Effect, and a package of its own would add a
  manifest for one module. It contains no business or transport logic.
- API route modules and worker job modules depend on `application` and `domain`,
  not on concrete database implementations.
- An app's composition root (`apps/api/src/main.ts` with
  `request-services-live.ts`, and `apps/worker/src/worker-runtime.ts`) may
  import every layer it needs, because its job is to select implementations,
  assemble the layer graph, provide `LoggingLive`, and launch the runtime.

pnpm enforces part of this. Each workspace package lists its own runtime
dependencies in its `package.json` (`catalog:` versions and `workspace:*`
links), and pnpm's isolated `node_modules` makes an undeclared import fail to
resolve. The root's development dependencies (test tooling, `effect` for
scripts) still resolve from every package during development, but the production
image installs only each package's declared dependencies. Declare every runtime
import in the manifest of the package that imports it.

Lint enforces the part pnpm cannot. Both apps depend on `@node-effect/database`
for their composition roots, so pnpm lets routes and jobs import it too. Lint
rejects imports of `@node-effect/database` and `effect/sql` in every folder
under `apps/*/src/`, tests included; only the files directly in `src/` may
import them. A composition root placed inside a feature folder needs its own
override in `.oxlintrc.json`.

## Layout

```text
apps/
  api/src/
    main.ts                       # HTTP server, logging, runtime launch
    request-services-live.ts      # adapters behind the ports routes use
    access-log.ts                 # one line per request, 5xx causes redacted
    app.ts                        # HttpApi routes, OpenAPI, Swagger UI, 404 and 500 envelope
    api-contract.ts               # root HttpApi: every group, OpenAPI metadata
    api-schemas.ts                # public error envelope, shared responses
    api-middleware.ts             # RequestValidation: schema errors to 400
    request-body.ts               # size-limited JSON body reader
    http-errors.ts                # persistence failures to logged 500 or 503
    health/
      api-contract.ts             # HttpApiGroup: endpoints and their schemas
      routes.ts                   # handlers
      test/routes.test.ts
    users/
      api-contract.ts
      routes.ts
      test/routes.test.ts
    test/                         # composition, contract helper, error tests
  worker/src/
    main.ts                       # persistent polling entry point
    once.ts                       # one pass of every job, then exit
    job-runner.ts                 # runs a job table: one-shot pass or polling
    worker-runtime.ts             # shared composition, logging, exit codes
    worker-errors.ts              # safe failure reporting
    jobs/
      sample-users.ts             # one job
      worker-jobs.ts              # the job table: every job the worker runs
      test/
    test/                         # job runner and failure reporting tests

packages/
  domain/
    index.ts                      # public package API
    src/user.ts                   # domain values, models, and errors
  application/
    index.ts
    src/database-health.ts        # readiness port: does the database answer
    src/persistence-failure.ts    # persistence failure fields, report, redaction, reportFailure
    src/users/user-repository.ts  # abstract service (port) and its error
  config/
    index.ts
    src/app-config.ts             # AppConfig, read by the API and the worker
    src/runtime-role-config.ts    # the runtime role's name and password, read by migrate only
    src/logging.ts                # LoggingLive: JSON lines with trace ids, at LOG_LEVEL
  database/
    index.ts
    src/postgres.ts               # PgClient and Database services and layers
    src/database-health-live.ts   # select 1 with a 5 second limit
    src/error-diagnostics.ts      # safe diagnostics from database causes
    src/database-call.ts          # databaseCalls, repositoryCalls: bounded calls that fail as a persistence failure
    src/migrate.ts                # migration entry point
    src/runtime-role.ts           # the API's and worker's role, which migrate provisions
    src/users/schema.ts           # Drizzle table and row schemas
    src/users/user-repository-live.ts
    src/test/                     # fake PgClient, migrated-database fixtures
    src/users/test/

drizzle/                          # generated migrations, committed
scripts/                          # init, OpenAPI export, type check, smoke, scan, static and toolchain checks
deploy/vps/                       # production Compose project and scripts
tools/oxlint/anti-slop/           # vendored lint rules
```

This is a guide, not a requirement to pre-create every possible file. Keep a
small feature in one cohesive file until splitting it gives the code a clearer
owner.

## Package or folder?

Create a package when code represents a dependency boundary with its own public
API or when it must be reused by more than one executable. For example, the
repository contract belongs in `application`, while its PostgreSQL
implementation belongs in `database`.

Create a feature folder inside an existing app or package when the code has the
same boundary and runtime dependencies as its neighbors. A new API feature
normally starts at `apps/api/src/<feature>/` with an `api-contract.ts` and a
`routes.ts`; it does not need a new workspace package.

Do not create a package merely because a file became long. First split the file
by responsibility within its existing boundary. Conversely, do not put reusable
business rules in an app-level `utils.ts` just because only one caller exists
today; ownership, rather than line count, decides the location.

## Where new code goes

| Code being added                                                           | Location                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Endpoint: method, path, params, payload, success and error schemas         | `apps/api/src/<feature>/api-contract.ts`, added to the root `api-contract.ts`                            |
| Handler: calling ports and mapping their errors to responses               | `apps/api/src/<feature>/routes.ts`, provided in `apps/api/src/app.ts`                                    |
| Public error response or schema shared by API groups                       | `apps/api/src/api-schemas.ts`                                                                            |
| Mapping a shared failure, such as a persistence failure, to HTTP           | `apps/api/src/http-errors.ts`                                                                            |
| What the API logs for each request                                         | `apps/api/src/access-log.ts`                                                                             |
| Log format, level, or another logger                                       | `packages/config/src/logging.ts`                                                                         |
| Adapter that the routes need                                               | `apps/api/src/request-services-live.ts`                                                                  |
| Worker job, or one-shot work                                               | `apps/worker/src/jobs/`, added to `workerJobs` in `worker-jobs.ts`                                       |
| Adapter that a worker job needs                                            | `WorkerServicesLive` in `worker-runtime.ts`                                                              |
| Business value, invariant, entity, command, or domain error                | `packages/domain/src/<feature>.ts`                                                                       |
| Use-case orchestration or outbound service contract                        | `packages/application/src/<feature>/`                                                                    |
| Persistence failure class                                                  | beside its port, built with `persistenceFailureFields`                                                   |
| PostgreSQL/Drizzle table, query, row mapping, or repository implementation | `packages/database/src/<feature>/`                                                                       |
| A new table file                                                           | `packages/database/src/<feature>/schema.ts`; the glob in `drizzle.config.ts` picks it up                 |
| A schema change                                                            | the table file, then `pnpm db:generate` writes `drizzle/`; `pnpm check` fails until the migration exists |
| Shared PostgreSQL client or Drizzle service                                | `packages/database/src/postgres.ts`                                                                      |
| Environment variable parsing, validation, or defaults                      | `packages/config/src/`, plus `.env.example`, `docker-compose.yml` and `deploy/vps/`                      |
| Production layer selection and process startup                             | the executable's composition root                                                                        |
| A fake service for a test                                                  | beside the consuming test                                                                                |
| Fixtures shared by several tests                                           | `*.fixtures.ts` in the `test/` folder                                                                    |

If a use case coordinates several ports or enforces an application workflow,
give it a named module in `application`. If it only calls one repository method
and returns the result unchanged, let the route or job use the repository
directly; a forwarding `UserService` adds no boundary.

## Effect services and layers

The code uses Effect 4's stable module paths: `effect/http`, `effect/http-api`,
`effect/sql` and `effect/testing`, never `effect/unstable/*`.

Keep the contract, implementation, composition, and test replacement separate:

1. Define the `Context.Service` contract in `application`, using domain inputs,
   outputs, and expected errors. The contract must not mention Drizzle or a
   concrete database error type.
2. Define its production `Layer` beside the adapter that implements it, named
   `<Service>Live`. For example, `UserRepositoryLive` lives in `database` and
   requires `Database`.
3. Keep each live layer's requirements visible. `UserRepositoryLive` requires
   `Database`, `DatabaseLive` requires `PgClient`, and `PgClientLive` requires
   `AppConfig`; none silently installs the next layer in the chain.
4. Connect that chain in the composition root, then provide configuration and
   logging at the outside edge. The API's `request-services-live.ts` builds the
   chain:

   ```ts
   const RequestServicesLive = Layer.mergeAll(
     DatabaseHealthLive,
     UserRepositoryLive,
   ).pipe(Layer.provide(DatabaseLive), Layer.provide(PgClientLive));
   ```

   `main.ts` provides it to the routes with `HttpRouter.provideRequest`, and
   provides `AppConfig.layer` to the server last. The worker's
   `worker-runtime.ts` builds the same chain and ends it with
   `Layer.provideMerge(AppConfig.layer)`: `PgClientLive` and the worker program
   both read `AppConfig`, and one layer builds it once for both. Give an effect
   its layers in one `Effect.provide`, merged or provided to each other: the
   type check fails on two in a row (Effect's `multipleEffectProvide` rule).

   Every entry point provides `LoggingLive` last, outside its failure reporter,
   so the report is a JSON line too. Never provide a logger or a log level
   inside the routes: HttpApi merges the context its handlers were built with
   over each request's, so it would replace the entry point's for those
   handlers.

5. In a consumer test, replace the contract directly with `Layer.succeed` or
   `Layer.mock`. Route and job unit tests should not start PostgreSQL or import
   a live database adapter. Test the adapter separately when database
   integration behavior is the subject of the test.

Choose the layer combinator by the relationship being expressed:

| Combinator           | Use it when                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Layer.provide`      | One layer satisfies another layer's requirement. The provider's services are internal to the result.          |
| `Layer.mergeAll`     | Layers are siblings whose outputs are all needed; it does not express that one supplies another.              |
| `Layer.provideMerge` | A provider satisfies a requirement and its service must deliberately remain available in the resulting layer. |

Prefer `provide` for an implementation chain. Use `mergeAll` for independent
capabilities, and use `provideMerge` only when downstream code genuinely needs
both the higher-level service and the lower-level provider. This keeps
infrastructure such as `Database` from leaking into ordinary consumers. The
PostgreSQL test fixtures are the deliberate exception: they keep the `SqlClient`
available so a test can arrange and inspect rows.

## HTTP API contracts

The API is schema-first. Each feature declares an `HttpApiGroup` in its
`api-contract.ts`: every endpoint's method, path, params, payload, success
schema with its status, and every error schema it can return. The root
`api-contract.ts` combines the groups into one `HttpApi` with OpenAPI metadata.
`routes.ts` implements the group with `HttpApiBuilder.group`, and `app.ts`
serves the API with its OpenAPI document at `/openapi.json` and Swagger UI at
`/docs`. `scripts/export-openapi.ts` prints the same document.

Errors follow these conventions:

- Every public error is `{ "error": { "code", "message" } }`, built with
  `publicError(status, code, message)` from `api-schemas.ts`. The code and
  message are literals, so the OpenAPI document lists exactly what a client can
  receive. It returns the `schema` an endpoint declares and the `body`, its only
  value, so the code and message are written once.
- Handlers fail with an error's `body` rather than building raw responses, so
  HttpApi checks every error against the contract. Domain errors map to their
  feature's responses (`UserNotFound` to 404, `UserAlreadyExists` to 409).
- A group behind the `RequestValidation` middleware turns schema errors in the
  path, query, headers and payload into `400 INVALID_REQUEST`. Failures to
  encode the server's own response stay internal errors.
- An endpoint with a JSON body states everything about it in its contract: its
  `payload` schema, its byte limit with `.pipe(withJsonBodyLimit(bytes))`, and
  `PayloadTooLargeResponse` and `UnsupportedMediaTypeResponse` among its errors,
  behind `RequestValidation`. Its handler is registered with
  `.handleRaw(name, jsonBodyHandler(handler))`; both helpers come from
  `request-body.ts`, and nothing else reads a body. `jsonBodyHandler` refuses a
  request whose media type is not `application/json` before reading it
  (`415 UNSUPPORTED_MEDIA_TYPE`), because a browser can post `text/plain`, or a
  body with no content type, to another site without a CORS preflight. It then
  decodes the body with that payload schema, stops reading past the limit
  (`413 PAYLOAD_TOO_LARGE`), rejects unknown fields and text that is not valid
  Unicode (`400 INVALID_REQUEST`), and passes the body to `handler`, with the
  request for its params, query and headers. Such text is bytes that are not
  UTF-8, or a lone surrogate written as an escape such as `\ud800`, either of
  which would be stored as U+FFFD, the replacement character; the reader refuses
  it, rather than each payload schema, so that every string of every endpoint is
  covered. It fails with those bodies, so an endpoint that leaves
  `PayloadTooLargeResponse` or `UnsupportedMediaTypeResponse` out of its errors,
  or a group that is not behind `RequestValidation`, does not compile. Neither
  does `handle` in place of `handleRaw`, with which HttpApi would read the body
  first: its own JSON decoding cannot answer 413, and past `MaxBodySize` it
  fails the request as a defect. A contract without the payload or the limit
  dies when the body is read, naming the endpoint.
- A persistence failure becomes `500 DATABASE_ERROR`, or
  `503 DATABASE_UNAVAILABLE` for readiness, through `http-errors.ts`.
- The server answers two errors by itself, outside any contract, and without a
  body: 404 for a request that matches no route, and 500 for a handler that
  dies. `app.ts` gives a 404 or a 500 that has no body the envelope as it is
  sent, `404 NOT_FOUND` or `500 INTERNAL_ERROR`, built from `publicError`'s
  `status` and `body`. Only what is sent changes: the request still fails with
  its cause, so the access log logs it as before.

## Schemas belong to their boundary

- Domain schemas describe business-valid data (`Email`, `UserId`,
  `CreateUserSchema`, `UserSchema`) and live in `domain`.
- HTTP schemas describe transport-only shapes such as path parameters, query
  strings, headers, responses, and error envelopes. They live in the feature's
  `api-contract.ts`, or in `api-schemas.ts` when shared. Reuse domain schemas
  inside them instead of duplicating business constraints.
- Drizzle tables and generated select/insert row schemas describe persistence.
  They live in `database` and are not the public business model.
- Configuration schemas describe environment input and live in `config`. A
  configuration service's type follows from its `Config`, as `AppConfig`'s does
  from `appConfig`, so each setting is stated once.

Crossing a boundary should be explicit. Map a database row or transport value to
the domain representation when their shapes or semantics differ. Do not derive
the public application model from a Drizzle table, and do not make an API
consumer import database schema code to validate a request.

Decode persisted rows with their row schema before returning them from a
repository, including rows returned by inserts. Run such a query with
`databaseCalls`' `one` or `many`, which decode its rows with the row schema and
map a decoding failure to the repository's persistence failure, so invalid
stored data is reported as a server-side failure.

## Errors and safe diagnostics

Every persistence failure is built from `persistenceFailureFields(operations)`
in `application`: a type-id brand, the failed `operation`, the raw `cause`, and
safe `diagnostics`. `isPersistenceFailure` and `persistenceFailureReport` let
the API and the worker handle any persistence failure without listing its class,
and the report, its tag, operation, and diagnostics, is the only form in which
one is logged. `redactPersistenceFailures` reduces every persistence failure in
a cause, also one that arrives as a defect, to that report.

Database adapters fill the diagnostics from the cause: the failure category, a
driver error code when it is a SQLSTATE or Node system error code, and
validation field paths. Raw causes remain available for inspection, but their
messages and stacks can contain SQL, parameters, or stored values and must not
reach handled-error logs. Database-wide extraction lives in
`packages/database/src/error-diagnostics.ts`. An adapter calls the database
through `databaseCalls(ErrorClass, timeout)` from
`packages/database/src/database-call.ts`, which a repository gets from
`repositoryCalls(ErrorClass)` with its timeout already set: its `run` bounds the
call and turns any failure into the adapter's error for that operation, with
those diagnostics. `one` and `many` do the same and then decode the rows the
query returns: `one` expects exactly one row, and `many` any number. Feature
adapters own only which outcomes are domain errors. `onUniqueViolation` names
the domain error that a unique violation on each constraint means, such as
`UserAlreadyExists` for the email constraint, and `one`'s `onMissing` names the
domain error that a missing row means, such as `UserNotFound`. `databaseCalls`
reads the violated constraint from Drizzle's error itself, and a unique
violation on any other constraint stays a persistence failure.

HTTP handlers log a persistence failure's report as log annotations, and keep
the response generic. The API's access log (`apps/api/src/access-log.ts`)
replaces Effect's built-in HTTP logger, which logs each response's raw cause: it
logs a 5xx response's cause with `redactPersistenceFailures`, and no cause for a
4xx, whose cause can repeat the URL with its query string.

The worker reports failures at its outer boundary, after configuration and
persistence scopes finish. It logs a copy of the cause with every persistence
failure reduced to its tag, operation, and diagnostics. That includes one that
arrives as a defect, which happens when a finalizer dies after the program
failed. The original failure and exit code remain intact, including any cleanup
defects. Unexpected errors keep their normal diagnostic details; this is not
universal secret redaction. Interruption-only exits remain quiet. The API's
`main.ts` reports a failure to start or serve the same way. Both use
`reportFailure(message)` from `application`, which the worker's reporter
annotates with its service. Keep each reporter paired with `runMain`'s
`disableErrorReporting: true`, which prevents the runtime from also logging the
raw cause, as text outside `LoggingLive`. `apps/api/src/test/main.test.ts` runs
`main.ts` as a process to check that and that Effect's built-in HTTP logger
stays off, since no module test can see either setting. The worker's
`src/test/main.test.ts` and `src/test/once.test.ts`, and the process tests in
`packages/database/src/test/migrate.test.ts`, run the other entry points the
same way, without PostgreSQL. They check that a failure, from configuration or
from a database that refuses connections, is logged once, as JSON, with nothing
on stderr, and that SIGTERM ends a polling pass in flight with exit 130 and no
log line. The reporters' own tests run them under a test logger. `LoggingLive`
reports its own failure, an invalid `LOG_LEVEL`, because nothing outside it can.

`migrate.ts` uses `reportFailure` too, with a redaction of its own:
`reportFailure(message, { isSensitive, report })` also reduces what
`isSensitive` accepts. The migrator fails with raw database errors rather than
persistence failures, so a database error is logged with its tag and
diagnostics, including one that arrives as a defect because ROLLBACK died on a
lost connection, while other failures, such as missing configuration, keep their
details.

## Process lifecycle

Each entry point runs with `NodeRuntime.runMain` from `@effect/platform-node`.
It exits 0 when the program completes, 1 when it fails, and 130 when SIGINT or
SIGTERM interrupts it, after running every finalizer. Containers run `node` as
PID 1, never `pnpm`, which does not pass signals on.

The API's PostgreSQL pool opens connections on demand, so unavailable PostgreSQL
does not prevent the HTTP process from starting. `/health/live` checks only
process liveness; `/health/ready` and its `/health` alias query the database
with a timeout. Container health checks use liveness, so a database outage never
restarts the API; deployment smoke checks and uptime monitoring use readiness.
On shutdown the server stops accepting connections and gives in-flight requests
up to 10 seconds. It keeps an idle keep-alive connection open for 95 seconds,
longer than Cloudflare Tunnel's 90, so the tunnel never sends a request on a
connection the API is closing (`apps/api/src/main.ts`).

`PgClientLive` bounds the wait for a pooled connection and has PostgreSQL limit
every statement (`DATABASE_STATEMENT_TIMEOUT_MS`), every lock wait, and every
session left idle inside a transaction. A statement or lock timeout carries its
SQLSTATE code (57014, 55P03) in the diagnostics, and a pool wait is a
`ConnectionError`. PostgreSQL enforces those limits, so they cannot fire when
the server stops answering. A repository therefore bounds each call itself:
`databaseCalls` requires a timeout, and `repositoryCalls` passes
`databaseCallTimeout` for the configured statement timeout, a little longer than
the pool wait and the statement together. A call that runs out is reported as a
`TimeoutError`. Each surfaces as an ordinary persistence failure. The one
exception is a session PostgreSQL ends for idling inside a transaction: its
connection goes with it, so the transaction's rollback fails and the transaction
dies with a defect. `packages/database/src/postgres.ts` gives the reason for
each value.

Both worker entry points hand the job table, `workerJobs` in
`jobs/worker-jobs.ts`, to the job runner in `job-runner.ts`. The persistent
entry point polls: it runs each job on an independent loop, so a slow job never
delays another, and passes of one job never overlap. The first failure in any
loop interrupts the others and fails the process. The worker does not retry; its
supervisor does (Compose's `restart: unless-stopped` locally and in production).
A pass that runs longer than `WORKER_PASS_TIMEOUT_MS` is interrupted and fails
the worker, so a hung pass is restarted too. Passes stay interruptible, so
SIGTERM can stop one. Either waits only for the driver to cancel a query in
flight, at most 5 seconds when the server does not answer. `once.ts` runs one
pass of every job, in order, and exits with its result; the first failure ends
the pass, so later jobs do not run. A job table holds at least one job, which
the type check enforces: with none, polling would end at once and the supervisor
would restart the worker forever. Both entry points share `worker-runtime.ts`,
whose `WorkerServicesLive` must provide every port the jobs need; the type check
rejects a job whose port has no adapter there. Keep durable workflow execution,
when you need it, in application contracts and PostgreSQL adapters rather than
growing this polling example into a runtime.

Neither application performs schema migrations at startup. Locally, the Compose
`migrate` service runs `packages/database/src/migrate.ts` and the API and worker
start only after it succeeds. It applies every migration in `drizzle/` that the
`drizzle.__drizzle_migrations` journal does not list, in one transaction, and
writes the same journal Drizzle Kit uses. The image therefore ships `drizzle/`
beside the code. It runs on `MigrationPgClientLive`, one connection without a
statement timeout, so long index builds finish, and with a 5 second lock
timeout, so an ALTER TABLE queued behind a long transaction fails the migration
instead of holding up every query on that table.

`migrate` connects as the database owner, a superuser in the PostgreSQL image.
After the migrations commit, it provisions the runtime role named by
`APP_DATABASE_USER` (`packages/database/src/runtime-role.ts`): a login role,
with no other attributes and in no other role, that may read and write the rows
of every table in `public`, including tables the owner creates later. The API
and the worker in Compose and in production connect as that role, so a query
they send cannot change the schema, read the migration journal, or reach the
server's files and programs; it keeps only what PostgreSQL grants every role,
such as temporary tables. `migrate` refuses a name that already belongs to the
owner, a superuser, a member of another role, or the owner of objects, before it
applies any migration. Its settings live in
`packages/config/src/runtime-role-config.ts`, apart from `AppConfig`, so the API
and the worker never need the password. Native development uses the owner's URL
for everything. A table outside `public` needs grants of its own in its
migration.

`deploy/vps/` holds the production Compose project and its release, backup,
backup-check and monitoring scripts. A release runs `migrate` once, as a
separate step, and restarts the API and worker only after it succeeds. Database
changes must tolerate the previous application version, which keeps running
until the restart and is what a rollback returns to: add columns and tables
first, and remove old ones in a later release.

## Testing

Tests live in a `test/` folder beside the code they cover: `src/<feature>/test/`
for a feature, and `src/test/` for modules directly under `src/`. The file
suffix decides how a test runs:

| Suffix          | Runs with            | Needs                                   |
| --------------- | -------------------- | --------------------------------------- |
| `*.test.ts`     | `pnpm test`          | Nothing: no database, no network        |
| `*.postgres.ts` | `pnpm test:postgres` | A PostgreSQL superuser's `DATABASE_URL` |
| `*.fixtures.ts` | not a test           | Shared setup imported by tests          |

Tests use `@effect/vitest`: `it.effect` for effects, `it.live` for real time and
I/O, and `TestClock` from `effect/testing` for timeouts and schedules. Replace a
service with `Layer.succeed` or `Layer.mock` beside the test that needs it.
Module mocking fails lint.

- **API tests** serve one handler group with `serveGroup(group, handlers)` from
  `apps/api/src/test/group-server.fixtures.ts`, given fake services. It checks
  every response against the contract: the contract must document the route the
  router matched and the status, and the body must match a schema declared for
  that status. It disposes of the server when the test finishes.
  `apps/api/src/test/app.test.ts` serves the whole API and checks that the
  served OpenAPI document equals `OpenApi.fromApi(Api)` and that every operation
  is listed with a unique operation ID. Add each new endpoint to its operation
  list.
- **Worker tests** run the job runner on synthetic jobs, which need no port, so
  adding or replacing a job leaves them alone. A job's own test fakes the ports
  it uses, as `apps/worker/src/jobs/test/sample-users.test.ts` does.
- **Database adapter unit tests** run the real Drizzle queries, row decoding,
  and error mapping against a fake `PgClient` (`pgClientLayer` and its
  connections in `packages/database/src/test/pg-client.ts`).
- **Configuration** in database tests comes from `testAppConfig(overrides)` in
  `packages/database/src/test/app-config.fixtures.ts`. It gives `appConfig`'s
  defaults, overridden by only the fields a test varies, and never reads the
  process environment, so `.env` changes no unit test.
- **PostgreSQL tests** wrap a test in `withMigratedDatabase(adapterLayer)` from
  `packages/database/src/test/migrated-database.fixtures.ts`. It creates a
  schema with a random name, applies every migration in `drizzle/`, points the
  connection's `search_path` at it through the URL's `options`, and drops it
  afterwards. `withEmptyDatabase` gives an empty schema. The runtime role tests
  also create and drop roles, which belong to the whole cluster, so they need a
  superuser and name each role uniquely. The setup file
  `packages/database/src/test/postgres.setup.ts` loads `.env` and fails clearly
  without `DATABASE_URL`. These files run one at a time.
- **Logs** in tests are captured with a `Logger` layer when a test asserts on
  them, for example that a secret never reaches a log line. A test of the lines
  production writes provides `LoggingLive` with a `TestConsole`, as
  `access-log.test.ts` does. Outside tests, lint rejects Effect's
  `Logger.console*` loggers: entry points provide `LoggingLive`.
- **Tests of generic code** use probes of their own rather than the users
  example: a `ProbeFailure` built with `persistenceFailureFields`, which
  `application` exports for them, or the `probe_items` table that the runtime
  role tests create. `migrate.postgres.ts` reads the tables it expects from the
  latest migration's snapshot. Replacing users then breaks only users' own
  tests, `app.test.ts`, the smoke scripts, and `once.test.ts` if the new jobs
  fail differently.

## Public imports

Each package exposes its supported surface through `index.ts`, which its
`package.json` `exports` field names. Code in another package imports that
surface:

```ts
import { UserRepository } from "@node-effect/application";
```

Do not deep-import another package's `src/` files. Relative imports are for
modules inside the same package or app, and end in `.ts`. Keep adapter-only
details out of `index.ts` unless another boundary, such as an app composition
root, intentionally needs them.

## Guardrails against accidental architecture

- Group code by feature within a boundary; avoid global `controllers/`,
  `services/`, and `repositories/` buckets in the apps.
- Add an interface or service contract at a real boundary, not for every
  function.
- Do not add a use-case class that merely forwards arguments.
- Do not create a global `AppLive` imported by every executable. Each executable
  owns its runtime graph and may choose different adapters.
- Keep handlers private to `routes.ts` until another module has a real need for
  them.
- Prefer a feature-local helper over a generic `shared` or `utils` module. Move
  it only after its ownership is genuinely shared.
- Avoid exposing `Database`, SQL, or Drizzle types to routes and jobs.
- Add folders and files as responsibilities appear; the layout is not a quota to
  fill.
