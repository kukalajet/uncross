import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  isPersistenceFailure,
  persistenceFailureFields,
  persistenceFailureReport,
} from "@node-effect/application";

// A persistence failure of the test's own, so the test does not depend on the
// users example.
class ProbeFailure extends Schema.TaggedError<ProbeFailure>()(
  "ProbeFailure",
  persistenceFailureFields(["read", "write"]),
) {}

describe("persistence failures", () => {
  it("recognize persistence failures and report them without the cause", () => {
    const error = new ProbeFailure({
      operation: "read",
      cause: new Error("secret driver message"),
      diagnostics: { reason: "AuthorizationError", code: "42501" },
    });

    assert.isTrue(isPersistenceFailure(error));

    assert.deepStrictEqual(persistenceFailureReport(error), {
      _tag: "ProbeFailure",
      operation: "read",
      diagnostics: { reason: "AuthorizationError", code: "42501" },
    });

    assert.notInclude(
      JSON.stringify(persistenceFailureReport(error)),
      "secret",
    );
  });

  it("do not recognize other errors", () => {
    assert.isFalse(isPersistenceFailure(new Error("unrelated")));
    assert.isFalse(isPersistenceFailure({ _tag: "ProbeFailure" }));
  });
});
