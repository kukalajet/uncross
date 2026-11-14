# Uncross

A small exchange (order matching system) written in TypeScript with Effect,
designed so that performance-critical stages can later be rewritten in Rust
without redesign.

Read `docs/DESIGN.md` before making architectural changes. It records the
decisions and the reasons behind them.

## Project rules

These must not be broken.

1. **The matching core is pure logic.** `@uncross/core` is plain synchronous
   TypeScript: `apply(book, command)` updates the book in place and returns the
   events. No Effect imports, no I/O, no clock reads, no randomness, no async.
   Timestamps and sequence numbers arrive inside the command.
2. **Determinism.** The same sequence of commands must always produce the same
   sequence of events, byte for byte.
3. **Integers only for money.** A price counts the instrument's ticks and a
   quantity counts its lots, held in `number` as safe integers. Never floats.
4. **Stages talk only through sequenced messages** in the language-neutral
   binary format defined in `@uncross/protocol`. No rich TypeScript objects
   cross a stage boundary.
5. **Every stage sits behind an Effect service interface**, so an alternative
   implementation (e.g. Rust via napi-rs or a separate process) is just another
   `Layer`.
6. **Journal before processing.** A command is sequenced and written to the
   journal before the engine sees it.

## Packages

Place exchange code where the "The exchange" section of `ARCHITECTURE.md` says;
`docs/DESIGN.md` gives the build order, starting with `@uncross/core`.

## Testing

- `core` is tested heavily before anything is built on it.
- Use `Schema` to validate at the edges and decode into the flat internal
  representation.
- Use `TestClock` for anything time-dependent; tests must be deterministic.
- Journal replay is the reference test: recorded commands in, identical events
  out.

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
- Imports in five groups: `node:` built-ins, packages, `@uncross/*`, `../`, then
  `./`.
- No module mocking: replace a service with `Layer.succeed` or `Layer.mock`.
- No `console`, `process.env` or `Effect.run*` in `apps/` or `packages/` outside
  tests: log with Effect, read `AppConfig`, and run effects only with
  `NodeRuntime.runMain` in an entry point, which provides `LoggingLive` from
  `@uncross/config` (JSON lines at `LOG_LEVEL`).
- No `@uncross/database` or `effect/sql` imports in any folder under
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
