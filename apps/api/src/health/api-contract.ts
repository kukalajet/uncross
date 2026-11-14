import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { DatabaseUnavailableResponse } from "../api-schemas.ts";

const LivenessResponse = Schema.Struct({ status: Schema.Literal("ok") });

const ReadinessResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  database: Schema.Literal("ok"),
});

// Liveness never touches the database, so an outage cannot get the process
// restarted. Readiness and its `/health` alias do query it.
const HealthApi = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("live", "/health/live", {
    success: LivenessResponse,
  }),
  HttpApiEndpoint.get("ready", "/health/ready", {
    success: ReadinessResponse,
    error: DatabaseUnavailableResponse.schema,
  }),
  HttpApiEndpoint.get("readyAlias", "/health", {
    success: ReadinessResponse,
    error: DatabaseUnavailableResponse.schema,
  }),
);

export { HealthApi, LivenessResponse, ReadinessResponse };
