import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";

import { UserRepository } from "@uncross/application";

import { sampleUsersPass } from "../sample-users.ts";

const user = {
  id: "d5b9d3de-fda5-4a78-b8a5-2f3b60634d95",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  createdAt: new Date("2026-08-09T12:00:00.000Z"),
};

describe("sampleUsersPass", () => {
  it.effect("reads at most five users and logs how many it found", () =>
    Effect.gen(function* () {
      const limits: Array<number> = [];
      const lines: Array<string> = [];

      const logger = Logger.map(Logger.formatJson, (line) => {
        lines.push(line);
      });

      const repository = Layer.mock(UserRepository, {
        list: (limit) =>
          Effect.sync(() => {
            limits.push(limit);

            return [user, user];
          }),
      });

      yield* sampleUsersPass().pipe(
        Effect.provide([
          repository,
          Logger.layer([logger]),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ]),
      );

      assert.deepStrictEqual(limits, [5]);
      assert.lengthOf(lines, 1);
      const log = JSON.parse(lines.join(""));
      assert.strictEqual(log.message, "Worker user sample loaded");
      assert.strictEqual(log.level, "DEBUG");

      assert.deepStrictEqual(log.annotations, {
        service: "worker",
        userCount: 2,
      });
    }),
  );
});
