import { Layer } from "effect";

import {
  DatabaseHealthLive,
  DatabaseLive,
  PgClientLive,
  UserRepositoryLive,
} from "@node-effect/database";

// The adapters behind the application ports the routes use, on one pool. Add a
// feature's repository here when its routes need it.
const RequestServicesLive = Layer.mergeAll(
  DatabaseHealthLive,
  UserRepositoryLive,
).pipe(Layer.provide(DatabaseLive), Layer.provide(PgClientLive));

export { RequestServicesLive };
