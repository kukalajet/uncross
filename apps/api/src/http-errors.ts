import { Effect } from "effect";

import {
  type PersistenceFailure,
  persistenceFailureReport,
} from "@uncross/application";

import {
  DatabaseErrorResponse,
  DatabaseUnavailableResponse,
} from "./api-schemas.ts";

// The cause can carry SQL, parameters, and stored values, so only the safe
// report reaches the log, the same one entry points log, and the response says
// nothing about the failure.
const logPersistenceFailure = (message: string, error: PersistenceFailure) =>
  Effect.logError(message).pipe(
    Effect.annotateLogs(persistenceFailureReport(error)),
  );

// A failed operation is a server error: 500.
const databaseFailure = (error: PersistenceFailure) =>
  logPersistenceFailure("Database operation failed", error).pipe(
    Effect.andThen(Effect.fail(DatabaseErrorResponse.body)),
  );

// A failed readiness check means the database cannot serve traffic: 503.
const healthFailure = (error: PersistenceFailure) =>
  logPersistenceFailure("Database health check failed", error).pipe(
    Effect.andThen(Effect.fail(DatabaseUnavailableResponse.body)),
  );

export { databaseFailure, healthFailure };
