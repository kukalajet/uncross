import { HttpApi, OpenApi } from "effect/http-api";

import { HealthApi } from "./health/api-contract.ts";
import { UsersApi } from "./users/api-contract.ts";

const Api = HttpApi.make("Api")
  .add(HealthApi, UsersApi)
  .annotate(OpenApi.Title, "node-effect-template API")
  .annotate(
    OpenApi.Description,
    "The schema-first contract for every API endpoint.",
  );

export { Api };
