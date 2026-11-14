import { connect, createServer, type Socket } from "node:net";

import { Effect } from "effect";

type PausableProxy = {
  readonly port: number;
  readonly pause: Effect.Effect<void>;
};

// A TCP proxy on 127.0.0.1 to `target`. Once paused it behaves like a server
// whose process is frozen, as after `docker compose pause`: open connections
// stay open and new ones are accepted, but nothing reaches the server or comes
// back, so a client gets no error to react to.
const pausableProxy = (target: {
  readonly host: string;
  readonly port: number;
}) =>
  Effect.gen(function* () {
    const sockets = new Set<Socket>();
    let paused = false;

    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    };

    const forward = (from: Socket, to: Socket) => {
      from.on("data", (chunk) => {
        if (!paused) {
          to.write(chunk);
        }
      });

      from.on("close", () => to.destroy());
    };

    const server = createServer((client) => {
      track(client);

      if (paused) {
        return;
      }

      const upstream = connect(target);

      track(upstream);
      forward(client, upstream);
      forward(upstream, client);
    });

    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.once("error", (cause) => resume(Effect.die(cause)));

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();

          resume(
            typeof address === "object" && address !== null
              ? Effect.succeed(address.port)
              : Effect.die(new Error("Proxy has no TCP address")),
          );
        });
      }),
      () =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) {
            socket.destroy();
          }

          server.close(() => resume(Effect.void));
        }),
    );

    return {
      port,
      pause: Effect.sync(() => {
        paused = true;
      }),
    } satisfies PausableProxy;
  });

export { pausableProxy };
