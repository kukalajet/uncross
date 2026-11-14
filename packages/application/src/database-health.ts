import { Context, Effect, Schema } from "effect";

import { persistenceFailureFields } from "./persistence-failure.ts";

class DatabaseHealthError extends Schema.TaggedError<DatabaseHealthError>()(
  "DatabaseHealthError",
  persistenceFailureFields(["check"]),
) {}

// Whether the database answers at all, for readiness. It belongs to no feature,
// so no repository has to carry it.
class DatabaseHealth extends Context.Service<
  DatabaseHealth,
  {
    readonly check: Effect.Effect<void, DatabaseHealthError>;
  }
>()("@node-effect/application/DatabaseHealth") {}

export { DatabaseHealth, DatabaseHealthError };
