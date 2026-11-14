import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import getExePath from "@effect/tsgo/lib/getExePath";

// Runs tsc with the Effect language service built in, so the type check also
// fails on the diagnostics that the @effect/language-service plugin in
// tsconfig.json turns on. @effect/tsgo ships one such tsc per TypeScript release
// it supports. getExePath returns the one built from the installed `typescript`
// and throws when there is none, whereas the `effect-tsgo tsc` command of later
// @effect/tsgo releases falls back to the build for TypeScript's latest stable
// release. Arguments pass through to tsc.

type Manifest = {
  readonly devDependencies?: Readonly<Record<string, string>>;
};

// A TypeScript update without an @effect/tsgo release that ships a tsc for it
// fails here, before `pnpm check` runs the tests, so the reason and what to do
// replace getExePath's stack trace.
const findTsc = () => {
  try {
    return getExePath();
  } catch (error) {
    const manifest: Manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    const pin = (name: string) => manifest.devDependencies?.[name] ?? "(none)";

    console.error(
      [
        error instanceof Error ? error.message : String(error),
        `The type check runs the tsc that @effect/tsgo builds from the installed typescript. package.json pins @effect/tsgo ${pin("@effect/tsgo")} and typescript ${pin("typescript")}.`,
        "Run pnpm install if node_modules is out of date. Otherwise update both together, to an @effect/tsgo release that ships a tsc for that TypeScript: its README lists them under Supported Package Versions.",
      ].join("\n"),
    );

    return undefined;
  }
};

const tsc = findTsc();

if (tsc === undefined) {
  process.exitCode = 1;
} else {
  const result = spawnSync(tsc, process.argv.slice(2), { stdio: "inherit" });

  if (result.error !== undefined) throw result.error;

  process.exitCode = result.status ?? 1;
}
