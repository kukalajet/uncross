import { Config, Context, Layer, Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

// PostgreSQL stores statement_timeout as a signed 32-bit number of
// milliseconds and refuses a larger value when a connection starts, which
// would fail every query rather than this check at startup.
const postgresMaxTimeoutMs = 2_147_483_647;

const StatementTimeoutMs = PositiveInt.check(
  Schema.isLessThanOrEqualTo(postgresMaxTimeoutMs),
);

const appConfig = Config.all({
  databaseUrl: Config.Redacted("DATABASE_URL"),
  databaseStatementTimeoutMs: Config.schema(
    StatementTimeoutMs,
    "DATABASE_STATEMENT_TIMEOUT_MS",
  ).pipe(Config.withDefault(10_000)),
  apiHost: Config.NonEmptyString("API_HOST").pipe(
    Config.withDefault("127.0.0.1"),
  ),
  apiPort: Config.Port("API_PORT").pipe(Config.withDefault(8000)),
  workerPollIntervalMs: Config.schema(
    PositiveInt,
    "WORKER_POLL_INTERVAL_MS",
  ).pipe(Config.withDefault(5000)),
  workerPassTimeoutMs: Config.schema(
    PositiveInt,
    "WORKER_PASS_TIMEOUT_MS",
  ).pipe(Config.withDefault(60_000)),
});

// The settings `appConfig` reads, so a new setting is added there only.
// `Config.all` drops `readonly` from its result; the service keeps it.
class AppConfig extends Context.Service<
  AppConfig,
  Readonly<Config.Success<typeof appConfig>>
>()("@node-effect/config/AppConfig") {
  // Reads `process.env` through the default ConfigProvider. Tests and tools
  // can replace the provider with `ConfigProvider.layer`.
  static readonly layer = Layer.effect(AppConfig, appConfig);
}

export { AppConfig, appConfig };
