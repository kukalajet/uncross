import { createServer, type Server } from "node:net";

import { PgClient } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { PgClientLive } from "../postgres.ts";

import { testAppConfig } from "./app-config.fixtures.ts";

const listeningPort = (server: Server) => {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on TCP");
  }

  return address.port;
};

// A local TCP server that counts connection attempts and closes each one
// before PostgreSQL's startup handshake.
const countingServer = Effect.acquireRelease(
  Effect.callback<{
    readonly port: number;
    readonly connections: () => number;
    readonly server: Server;
  }>((resume) => {
    let connections = 0;

    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });

    server.listen(0, "127.0.0.1", () =>
      resume(
        Effect.succeed({
          port: listeningPort(server),
          connections: () => connections,
          server,
        }),
      ),
    );
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

const pgClientFor = (port: number) =>
  PgClientLive.pipe(
    Layer.provide(
      testAppConfig({
        databaseUrl: Redacted.make(
          `postgresql://test:test@127.0.0.1:${port}/test`,
        ),
      }),
    ),
  );

describe("PgClientLive", () => {
  it.live("acquires and closes the pool without connecting", () =>
    Effect.gen(function* () {
      const { port, connections } = yield* countingServer;

      const applicationName = yield* PgClient.PgClient.use((client) =>
        Effect.succeed(client.config.applicationName),
      ).pipe(Effect.provide(pgClientFor(port)));

      assert.strictEqual(applicationName, "node-effect-template");
      assert.strictEqual(connections(), 0);
    }),
  );

  it.live("connects once a query runs", () =>
    Effect.gen(function* () {
      const { port, connections } = yield* countingServer;

      yield* SqlClient.SqlClient.use((sql) => sql`select 1`).pipe(
        Effect.flip,
        Effect.provide(pgClientFor(port)),
      );

      assert.isAbove(connections(), 0);
    }),
  );
});
