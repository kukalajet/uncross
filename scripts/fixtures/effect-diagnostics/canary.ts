import { it } from "@effect/vitest";
import { Effect } from "effect";

// One of each mistake that Effect's diagnostics are in the type check to catch.
// The root tsconfig.json leaves this folder out; scripts/typecheck.test.ts
// type-checks it on its own and expects each mistake to fail as an error.
const program = Effect.gen(function* () {
  // floatingEffect: built and never run.
  Effect.log("floating");
  // missingStarInYieldEffectGen: yields the Effect itself, not its result.
  yield Effect.log("missing star");
});

// floatingEffectInVitest: Vitest passes the test without running the Effect.
it("returns an Effect", () => program);

export { program };
