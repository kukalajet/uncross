// Breaks each purity rule that .oxlintrc.json applies to packages/core/, once.
// Each directive silences the error it expects, and lint fails on a directive
// that silences nothing (reportUnusedDisableDirectives), so `pnpm check` fails
// if a rule stops applying to this package. Nothing imports this file.

// oxlint-disable-next-line eslint/no-restricted-imports -- canary: a package
import { Effect } from "effect";

// oxlint-disable-next-line eslint/no-restricted-globals -- canary: a clock read
const now = Date.now();

// oxlint-disable-next-line eslint/no-restricted-properties -- canary: randomness
const roll = Math.random();

export { Effect, now, roll };
