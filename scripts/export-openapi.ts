import { OpenApi } from "effect/http-api";

import { Api } from "../apps/api/src/api-contract.ts";

// Prints the API's OpenAPI document, for generating clients or diffing the
// contract in review: `pnpm --silent openapi > openapi.json`.
console.log(JSON.stringify(OpenApi.fromApi(Api), null, 2));
