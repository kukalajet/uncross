## Code style

Follow `READABILITY.md` when writing or changing code. In particular: never
chain ternaries. Map a closed set of values (statuses, kinds, variants) with a
lookup table typed `satisfies Record<Union, ...>`, use a `switch` when the cases
run logic, and use a small function with early returns for conditions checked in
priority order. `eslint/no-nested-ternary` fails lint.

Put code where `ARCHITECTURE.md` says it belongs, and keep its dependency
direction: routes and jobs use application ports, never database adapters.

Lint (`.oxlintrc.json`) also requires:

- One trailing `export { ... }` list per module: no inline `export const`,
  `function`, `class` or `type`, and a default export is
  `export { name as default }`.
- A `// SAFETY:` comment before every `as` assertion other than `as const`.
- A blank line before `return`, around multi-line blocks, and around any other
  multi-line statement. A `type X = typeof X…` alias may sit directly under the
  declaration it reads.
- Imports in five groups: `node:` built-ins, packages, `@node-effect/*`, `../`,
  then `./`.
- No module mocking: replace a service with `Layer.succeed` or `Layer.mock`.
- No `console`, `process.env` or `Effect.run*` in `apps/` or `packages/` outside
  tests: log with Effect, read `AppConfig`, and run effects only with
  `NodeRuntime.runMain` in an entry point, which provides `LoggingLive` from
  `@node-effect/config` (JSON lines at `LOG_LEVEL`).
- No `@node-effect/database` or `effect/sql` imports in any folder under
  `apps/*/src/`, tests included. Provide adapters in the composition roots
  directly in `src/` (`request-services-live.ts`, `worker-runtime.ts`).
- No non-null assertions (`x!`), no `{…} as T` (annotate the variable or use
  `satisfies`), and no shadowed names.

Node runs the TypeScript sources directly by stripping types, so relative
imports end in `.ts` (lint rejects `.js`), type-only imports use `import type`,
and enums, namespaces, parameter properties and `<T>value` assertions are not
allowed.

`pnpm check` must pass before a change is done; `pnpm fix` formats and
lint-fixes. `pnpm check` includes `pnpm db:verify`, so a schema change needs its
generated migration (`pnpm db:generate`). Never edit the migrations in
`drizzle/` or the vendored `tools/oxlint/anti-slop/`.

`pnpm check` type-checks with `@effect/tsgo`'s build of `tsc`, so Effect's
diagnostics fail it like type errors: an Effect that is never run, `yield` where
`yield*` is meant, an Effect returned from a plain Vitest `it`, and two
`Effect.provide` calls in a row. Fix the code; to accept a finding on one line,
put `// @effect-diagnostics-next-line <rule>:off` above it with a comment saying
why.
