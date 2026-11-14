import {
  Config,
  Context,
  Effect,
  Formatter,
  Layer,
  Logger,
  References,
  Tracer,
} from "effect";

// Effect's level names, which are case-sensitive: All, Trace, Debug, Info,
// Warn, Error, Fatal or None.
const logLevelConfig = Config.LogLevel("LOG_LEVEL").pipe(
  Config.withDefault("Info"),
);

// Logger.consoleJson's line, plus the current span's ids when there is one, so
// every line a request logs carries the trace id of its access log line. A line
// logged outside any span is exactly consoleJson's.
const jsonLogger = Logger.withConsoleLog(
  Logger.make((options) => {
    const line = Logger.formatStructured.log(options);

    const span = Context.getOrUndefined(
      options.fiber.context,
      Tracer.ParentSpan,
    );

    if (span === undefined) return Formatter.formatJson(line);

    return Formatter.formatJson({
      ...line,
      traceId: span.traceId,
      spanId: span.spanId,
    });
  }),
);

// Replaces Effect's default text logger. tracerLogger, the other default, is
// kept so a trace exporter added later shows each line as an event on its
// span. An event carries the cause its line logged, which the app reduces
// before logging; what an exporter must still redact, span exits and URLs, is
// in the README's Logs section.
const loggers = Logger.layer([jsonLogger, Logger.tracerLogger]);

// Every entry point's logging: JSON lines at LOG_LEVEL and above. The entry
// points turn off runMain's own reporting, and nothing outside this layer
// logs JSON, so an invalid LOG_LEVEL is reported here before the layer fails.
const LoggingLive = Layer.unwrap(
  Effect.map(logLevelConfig, (level) =>
    Layer.mergeAll(loggers, Layer.succeed(References.MinimumLogLevel, level)),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logError("Invalid logging configuration", cause),
    ),
    Effect.provide(loggers),
  ),
);

export { LoggingLive };
