import { assert, describe, it } from "@effect/vitest";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Schema } from "effect";
import { SqlError } from "effect/sql";

import { diagnosticsFromCause } from "../error-diagnostics.ts";

describe("diagnosticsFromCause", () => {
  for (const { code, reason } of [
    { code: "42501", reason: SqlError.AuthorizationError },
    { code: "57014", reason: SqlError.StatementTimeoutError },
    { code: "55P03", reason: SqlError.LockTimeoutError },
    { code: "ECONNREFUSED", reason: SqlError.UnknownError },
  ]) {
    it(`retains ${code} without query or driver data`, () => {
      const driverCause = Object.assign(new Error("secret driver message"), {
        code,
        detail: "secret row detail",
      });

      const sqlReason = new reason({ cause: driverCause });

      const cause = new EffectDrizzleQueryError({
        query: "select 'secret SQL'",
        params: ["secret parameter"],
        cause: Cause.fail(new SqlError.SqlError({ reason: sqlReason })),
      });

      const diagnostics = diagnosticsFromCause(cause);

      assert.deepStrictEqual(diagnostics, { reason: sqlReason._tag, code });
      assert.notInclude(JSON.stringify(diagnostics), "secret");
    });
  }

  it("omits unrecognized causes and unsafe codes", () => {
    const cause = Object.assign(new Error("secret error message"), {
      _tag: "secret category",
      code: "secret driver code",
    });

    assert.deepStrictEqual(diagnosticsFromCause(cause), {
      reason: "UnknownError",
    });

    assert.deepStrictEqual(
      diagnosticsFromCause(
        new SqlError.SqlError({
          reason: new SqlError.ConnectionError({ cause }),
        }),
      ),
      { reason: "ConnectionError" },
    );
  });

  it("reports a timeout by its category", () => {
    assert.deepStrictEqual(
      diagnosticsFromCause(new Cause.TimeoutError("secret timeout message")),
      { reason: "TimeoutError" },
    );
  });

  it.effect("keeps validation paths without the reported input", () =>
    Effect.gen(function* () {
      const cause = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ count: Schema.Number }),
      )({ count: "secret invalid count" }, { reportInput: true }).pipe(
        Effect.flip,
      );

      const diagnostics = diagnosticsFromCause(cause);

      assert.include(cause.message, "secret invalid count");

      assert.deepStrictEqual(diagnostics, {
        reason: "SchemaError",
        validationPaths: ["count"],
      });

      assert.notInclude(JSON.stringify(diagnostics), "secret");
    }),
  );
});
