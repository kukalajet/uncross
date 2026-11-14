import { spawnSync } from "node:child_process";

import { assert, describe, it } from "@effect/vitest";

// Effect's diagnostics come from the @effect/language-service entry in
// tsconfig.json. The type check ignores an entry whose name does not match, and
// that entry's options can turn the diagnostics off or keep them out of the exit
// code. Either way the type check would pass the mistakes it is there to catch,
// so this test type-checks a fixture that makes each of them.
const canaryConfig = "scripts/fixtures/effect-diagnostics/tsconfig.json";

const rules = [
  "floatingEffect",
  "missingStarInYieldEffectGen",
  "floatingEffectInVitest",
];

// A diagnostic as tsc prints it without --pretty, ending with Effect's rule.
const effectErrorPattern = /^.+: error TS\d+: .+ effect\((?<rule>\w+)\)$/gm;

describe("scripts/typecheck.ts", () => {
  it("fails on each mistake that Effect's diagnostics are there to catch", () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      ["scripts/typecheck.ts", "--pretty", "false", "--project", canaryConfig],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );

    const reported = Array.from(
      stdout.matchAll(effectErrorPattern),
      (match) => match.groups?.["rule"],
    );

    const advice = [
      `Type-checking ${canaryConfig} must fail with ${rules.join(", ")} as errors.`,
      "Check the @effect/language-service entry in tsconfig.json: its name, and any option that turns these diagnostics off, lowers them, or leaves them out of the exit code.",
      `Exit status: ${status ?? "(none)"}`,
      `Output: ${`${stdout}${stderr}`.trim() || "(empty)"}`,
    ].join("\n");

    assert.notStrictEqual(status, 0, advice);
    assert.includeMembers(reported, rules, advice);
  });
});
