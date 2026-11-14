import { Cause, Effect, Predicate, Schema } from "effect";

const PersistenceFailureTypeId = "~@node-effect/application/PersistenceFailure";

// Database adapters derive these from the raw cause without copying
// messages, SQL, parameters, or stored values.
const PersistenceDiagnostics = Schema.Struct({
  reason: Schema.String,
  code: Schema.optional(Schema.String),
  validationPaths: Schema.optional(Schema.Array(Schema.String)),
});

// Every persistence failure is built from these fields, so callers can
// recognize one without listing each class.
const persistenceFailureFields = <
  const Operations extends ReadonlyArray<string>,
>(
  operations: Operations,
) => ({
  [PersistenceFailureTypeId]: Schema.tag(PersistenceFailureTypeId),
  operation: Schema.Literals(operations),
  cause: Schema.Defect(),
  diagnostics: PersistenceDiagnostics,
});

type PersistenceFailure = {
  readonly [PersistenceFailureTypeId]: typeof PersistenceFailureTypeId;
  readonly _tag: string;
  readonly operation: string;
  readonly cause: unknown;
  readonly diagnostics: typeof PersistenceDiagnostics.Type;
};

const isPersistenceFailure = (u: unknown): u is PersistenceFailure =>
  Predicate.hasProperty(u, PersistenceFailureTypeId);

// The cause can carry SQL, parameters, and stored values; log this instead.
const persistenceFailureReport = (error: PersistenceFailure) => ({
  _tag: error._tag,
  operation: error.operation,
  diagnostics: error.diagnostics,
});

// Replaces each failure or defect that `isSensitive` accepts with its
// `report`, and keeps every other reason as it is. `Cause.map` is not enough:
// when a finalizer dies after the program failed, Effect reports the original
// failure as a defect too.
const redactCause = <A>(
  cause: Cause.Cause<unknown>,
  isSensitive: (value: unknown) => value is A,
  report: (value: A) => unknown,
): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      if (Cause.isFailReason(reason) && isSensitive(reason.error)) {
        return Cause.makeFailReason(report(reason.error));
      }

      if (Cause.isDieReason(reason) && isSensitive(reason.defect)) {
        return Cause.makeDieReason(report(reason.defect));
      }

      return reason;
    }),
  );

// The cause with every persistence failure in it, also one that arrives as a
// defect, reduced to its report. Anything else keeps its details.
const redactPersistenceFailures = (cause: Cause.Cause<unknown>) =>
  redactCause(cause, isPersistenceFailure, persistenceFailureReport);

// Failures an entry point holds besides persistence failures whose details are
// not safe to log, such as the raw database errors `migrate` sees.
type Redaction<A> = {
  readonly isSensitive: (value: unknown) => value is A;
  readonly report: (value: A) => unknown;
};

// An entry point's failure reporter: logs `message` and the cause once, with
// persistence failures, and whatever `redaction` accepts, reduced to their
// reports. Interruption is a normal shutdown, not a failure, so it logs
// nothing.
const reportFailure =
  <A = never>(message: string, redaction?: Redaction<A>) =>
  (cause: Cause.Cause<unknown>) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;

    const redacted = redactPersistenceFailures(cause);
    if (redaction === undefined) return Effect.logError(message, redacted);

    return Effect.logError(
      message,
      redactCause(redacted, redaction.isSensitive, redaction.report),
    );
  };

export {
  isPersistenceFailure,
  type PersistenceFailure,
  persistenceFailureFields,
  persistenceFailureReport,
  redactPersistenceFailures,
  reportFailure,
};
