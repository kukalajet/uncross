# Uncross - design notes

Status: initial design. Captured from a planning conversation on 2026-11-14.

## What it is

Uncross is a small exchange: it accepts buy and sell orders, matches them by the
rules described in Larry Harris's _Trading and Exchanges_, and publishes the
resulting trades and prices.

It is a full Effect (Node) project today. It is shaped so the speed-critical
stages can be replaced by Rust one at a time, when and if performance requires
it.

The name: a book is "crossed" when the best bid is at or above the best ask. To
uncross is to execute the overlapping orders, most visibly at the end of a call
auction, when all matchable orders trade at a single price.

## Goals and non-goals

Goals

- Learn market microstructure by implementing it, and learn Effect on a real
  domain.
- A correct, well-tested, auditable matching engine; a strong portfolio piece.
- An architecture that allows a stage-by-stage Rust migration behind stable
  contracts.

Non-goals

- Competing with real exchange infrastructure on latency (microsecond-level,
  co-located flow).
- Being a complete venue: custody, clearing and settlement, KYC/AML,
  surveillance and regulatory reporting are out of scope.

## Architecture

```
clients -> gateway -> sequencer -> matching engine -> publishers -> clients
                          |                               |
                       journal                 market data, trade reports
```

This follows the LMAX pattern: a deterministic single-threaded core fed by a
sequenced, journaled command stream.

- **Gateway** - accepts connections, authenticates, validates orders, converts
  them to compact commands.
- **Sequencer** - imposes one total order on all commands, stamps each with a
  sequence number and timestamp, writes it to the journal before anything else
  sees it.
- **Matching engine** - applies each command to the order book and emits events
  (accepted, trade, cancelled, book update).
- **Publishers** - turn events into market data feeds, private execution reports
  and downstream outputs.
- **Journal** - the sequenced command log. Engine state is a fold over it,
  giving recovery, replay, audit and testing.

## Design rules

1. The engine is pure logic: `apply(book, command)` updates the book in place
   and returns the events, with no I/O, no clock, no randomness and no async.
   Time and sequence numbers arrive in the command.
2. Commands in, events out, both sequenced.
3. The boundary between stages is a language-neutral binary wire format
   (candidates: SBE, FlatBuffers, or a hand-rolled fixed layout), with integer
   prices and quantities.
4. Stages communicate through queues. Today these are Effect `Queue`s in one
   process; later they can be shared-memory ring buffers or Aeron channels
   between processes.
5. Effect stays out of the matching logic. Effect wires, supervises and tests
   the pipeline; the core is plain TypeScript over plain data, wrapped in a
   `MatchingEngine` service.

## Where Effect is used

Services and `Layer`s for wiring; `Queue`, `Stream` and `PubSub` between stages
and for market data fan-out; `Schema` (with branded types) for validation at the
edges; typed errors; supervision and retries; metrics; `TestClock` for
deterministic tests.

## Functional scope of the engine

- Order types: market, limit, stop, IOC, FOK, iceberg.
- Price-time priority.
- Continuous trading and call auctions (single-price uncross, volume-maximising
  price).
- Later, optionally: a quote-driven dealer market as an alternative market
  structure, implemented as another `Layer` so the same order flow can be run
  through each.

## Rust migration path

- Each stage sits behind a service interface, so a Rust implementation is
  another `Layer`.
- Order of migration: matching engine, then sequencer and journal, then gateway.
  Effect remains as the control plane (admin, monitoring, reference data,
  reporting).
- Verification: replay recorded journals through both implementations and
  require byte-identical event streams. Both can run in parallel before cutover.
- Caveats: this is a rewrite of each stage behind a stable contract, not an
  incremental code migration. Calling Rust in-process through napi-rs has a
  per-call boundary cost, so the interface must stay narrow (integers and
  buffers in, events out, batched). Moving only the matching function to Rust
  gains little, because the latency problem is tail latency from GC and the
  event loop across the whole hot path, not matching throughput.

## Early decisions

Decided on 2026-11-14:

- **Units.** A price is an integer count of the instrument's ticks and a
  quantity an integer count of its lots. The gateway converts with the tick and
  lot sizes from reference data, so core never handles decimals and an off-tick
  price cannot be expressed.
- **Width.** Prices and quantities are `number`s holding safe integers (at most
  2^53 - 1), and the edges reject anything larger. `bigint` would cover Rust's
  full `i64` range, but it allocates on every operation and mixes with neither
  `number` nor JSON. A Rust port uses `i64` within the same bound.
- **State.** The engine owns its order book and updates it in place:
  `apply(book, command)` returns only the events, as an LMAX business logic
  processor or a Rust `&mut self` method does. Replay rebuilds the state, so
  determinism needs no immutability, and core needs no persistent data
  structures, which it could not import.

Still open, and hard to defer:

- The wire format.
- Threading and process model.
- Whether risk checks sit before or after the sequencer.

## Packages and build order

`ARCHITECTURE.md` places each piece. They are built in this order:

1. `@uncross/core` (`packages/core/`) - order book and matching function.
2. `@uncross/protocol` (`packages/protocol/`) - command and event formats.
3. The stages in Effect: their ports in `@uncross/application`, the engine
   adapter in `packages/engine/`, sequencing and the journal in
   `packages/journal/`, and the gateway, pipeline and publishers in
   `apps/exchange/`.
4. The simulator in `apps/sim/` - agent-based: one fiber per trader, using
   Harris's trader types (informed traders, noise traders, value traders,
   dealers, order anticipators, bluffers). Doubles as load generator and test
   harness.

Each package is created when its first code lands.

Possible later additions: a market-maker bot inside the simulator; a transaction
cost analyzer (effective spread, realized spread, price impact, implementation
shortfall, VWAP benchmarks).

## Naming and availability (checked 2026-11-14)

- npm: `uncross`, `uncross-engine` and `@uncross/core` returned not found; no
  packages are published under an `@uncross` scope. Not yet reserved.
- GitHub: the `Uncross` handle is taken by a user account with no public
  repositories. Host the repo under a personal account or a differently named
  org.
- Domains and trademarks: not checked.
- Rejected: "Tick" (npm name and GitHub handle taken; Tickspot trades as
  "Tick").

## Commercial notes

A standalone matching engine is hard to sell: matching is a commodity, buyers
want a track record and support, and the engine is a small part of a venue. More
plausible directions: markets that are not securities exchanges (prediction
markets, game economies, niche marketplaces), simulation for education and
research, exchange simulators as testing infrastructure, and the project as a
portfolio or teaching piece. If a product is wanted, choose the customer before
the architecture.
