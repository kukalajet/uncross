# Readability

These rules are about whether a reader can recover the author's intent from the
code alone. The lint configuration already covers formatting, import order, and
type safety; it cannot tell whether a condition says what it means, whether
`undefined` carries two meanings, or whether an early exit skips one item or
abandons the whole operation. These rules cover that gap, for people and agents
alike.

Lint in this repository (`.oxlintrc.json`) enforces rules 1, 3 and 10, the
shadowing part of rule 6, and the blank-line part of rule 8; those sections name
the lint rule. The rest rely on authors and review.

The rules are not a quota. Extract a helper when it names a step or a rule, not
to make a function shorter. A long function that reads top to bottom as one
story is better than five short ones the reader has to jump between.

## 1. Name domain rules

A regex, an error code, a magic string or number, or a compound condition that
encodes a rule from outside the code gets a name. If the rule comes from an
external system, say where it comes from.

```ts
// Before
/^[A-Z]{3}$/.test(price.currency);

// After
// ISO 4217 currency codes are three upper-case letters, such as EUR.
const currencyCodePattern = /^[A-Z]{3}$/;
```

When several places depend on the same external scheme (a code pattern, a set of
codes, a prefix check), keep them together so the scheme is described once.
Driver error codes, for example, are recognized once in
`packages/database/src/error-diagnostics.ts` rather than in each repository's
error mapper.

`readDriverCode` in that file is the house example: `isSqlState` and
`isSystemErrorCode` name what each regex means before the condition uses them.

Lint: `anti-slop/no-inline-regex-match` rejects a regex literal passed to
`test`, `exec`, `match`, `matchAll`, or `search`, unless the result of `.test()`
is assigned to a named const as in `readDriverCode`. Test files (anything in a
`test/` folder, and `*.test.ts`, `*.postgres.ts` and `*.fixtures.ts` files) are
exempt, because there the regex is usually the expected value itself.

## 2. Keep type narrowing out of the rule

Narrowing `unknown` needs boilerplate (`typeof`, `in`, null checks). When that
boilerplate shares a condition with the actual rule, the rule is hard to find.
Move the narrowing into a named guard, so what is left reads as the rule.

```ts
// Before
const isRetryableFailure = (error: unknown): error is HttpFailure =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number" &&
  error.status >= 500;

// After
const isRetryableFailure = (error: unknown): error is HttpFailure =>
  hasNumberProperty(error, "status") && isServerErrorStatus(error.status);
```

Every package here depends on Effect, so prefer `Predicate.hasProperty` (as
`readDriverCode` does) or `Schema.is(Schema.Struct({ ... }))`. In a script that
does not import Effect, write a small named guard beside its use, as
`scripts/smoke-api.ts` does with `isObject`.

## 3. Give a loop body one job

A loop that builds a collection usually has two levels of logic: whether one
item qualifies, and the policy for the collection as a whole (a limit,
deduplication, failing when nothing qualified). Mixing them forces the reader to
track both on every line.

Move the per-item step into a function that returns `Option` (or a tagged
result), and keep the loop to the collection policy. More than two guard
`continue`s in one loop body is the signal.

<!-- oxfmt-ignore -->
```ts
// Before: whether a line qualifies and the invoice limit share one body
for (const line of order.lines) {
  if (invoiceLines.size >= invoiceLimits.maxLines) break;
  if (line.quantity === 0) continue;
  const product = yield* catalog.findById(line.productId);
  if (Option.isNone(product)) continue;
  if (product.value.discontinued) continue;
  invoiceLines.set(product.value.sku, {
    sku: product.value.sku,
    quantity: line.quantity,
  });
}

// After: the loop is only about the collection
for (const line of order.lines) {
  if (invoiceLines.size >= invoiceLimits.maxLines) break;

  const invoiceLine = yield* invoiceLineFor(line);

  if (Option.isSome(invoiceLine)) {
    invoiceLines.set(invoiceLine.value.sku, invoiceLine.value);
  }
}
```

Lint: `anti-slop/max-loop-skips` flags a loop with more than two
`if (...) continue;` guards. A `continue` that ends a larger branch, like an
`else`, doesn't count.

## 4. Make "skip" and "abort" look different

Inside `Effect.gen`, a `yield*` of a failing effect abandons the whole
operation, while `continue` or `Option.none()` only skips the current item. When
both appear in the same block they look alike, and the reader has to open every
helper to learn which failures are fatal.

- Put skips in the return value (`Option`, a tagged result) and aborts in the
  error channel.
- When a function can do both, say in a comment which failures abort and why.

```ts
// None: the product is unknown or discontinued, so the caller moves on to the
// next order line.
// Failure: the catalog could not be read, so no invoice can be built at all.
const invoiceLineFor = (
  line: OrderLine,
): Effect.Effect<Option.Option<InvoiceLine>, CatalogPersistenceFailure> =>
  Effect.gen(function* () {
    const catalog = yield* CatalogRepository;
    const product = yield* catalog.findById(line.productId);

    return Option.filter(product, (found) => !found.discontinued).pipe(
      Option.map((found) => ({ sku: found.sku, quantity: line.quantity })),
    );
  });
```

## 5. Give each value one meaning

Don't let `undefined`, `null`, an empty string, or `-1` stand for two different
situations. If absence can have two causes, branch before the value is created.

Test a discriminant once per flow. If `_tag` is checked in several places along
the same path, move the branch into the one function that needs it.

```ts
// Before: `undefined` means both "a pickup order needs no address" and "the
// customer has no address on file", so the tag is tested twice here and again
// downstream.
const address =
  order._tag === "Delivery" ? findShippingAddress(customer) : undefined;
const canFulfill = order._tag === "Pickup" || address !== undefined;

// After: the function that already branches on the tag owns address lookup.
const resolveFulfillment = (order: Order, customer: Customer) => {
  if (order._tag === "Pickup") return Option.some(pickUpAt(order.storeId));

  const address = findShippingAddress(customer);
  if (address === undefined) return Option.none();

  return Option.some(shipTo(address));
};
```

## 6. Use one name per concept

Within a function, one word should not name several things. A checkout function
with `request.items`, `cartItems`, and `items` side by side holds three
different values (submitted, decoded, priced) that the reader has to tell apart
by position. Name by role instead: keep "items" for what the client submitted,
and call the others `cartLines` and `pricedLines`.

The same applies to state: one concept, one structure. A `seen` set next to a
`recipients` array is a single idea, "unique recipients in order", which a
`Map<string, Recipient>` keyed by email expresses directly.

Lint: `eslint/no-shadow` rejects the plainest case, an inner variable that hides
an outer one with the same name.

## 7. Keep Effect plumbing out of the main line

A generator body should read as a list of steps. Decoder construction, error
mapping, and result conversion are plumbing; when they take three lines inside
the body, the step they serve gets lost. Hoist decoders to module-level
constants, as `packages/database/src/users/user-repository-live.ts` does with
`decodeUserRow` and `decodeUserRows`, and wrap repeated pipelines in a named
helper, as `apps/api/src/request-body.ts` does with `jsonBody`.

<!-- oxfmt-ignore -->
```ts
// Before
const order = yield* Schema.decodeUnknownEffect(CreateOrderSchema)(
  request.body,
).pipe(Effect.mapError(() => invalidOrder(request.id)));

// After
const order = yield* decodeOrder(request.body, request.id);
```

## 8. Separate phases with a blank line

Lint requires a blank line before a `return` that follows another statement
(`anti-slop/blank-line-before-return`), around multi-line blocks
(`anti-slop/blank-line-around-blocks`), and around any other statement that
spans more than one line (`anti-slop/blank-line-around-multiline-statements`).
That last rule lets a type alias that reads the declaration above it stay
attached, so a schema and its type read as one unit:

```ts
const UserId = Schema.String.check(Schema.isUUID());
type UserId = typeof UserId.Type;

const CreateUserSchema = Schema.Struct({
  email: Email,
  displayName: DisplayName,
});
type CreateUser = typeof CreateUserSchema.Type;
```

Apply the same idea between the phases of a function: setup, the main work, and
the result. A wall of twenty lines with no breaks hides where one step ends and
the next begins.

## 9. Comment decisions, not steps

A comment should explain what the reader cannot recover from the code: why a
failure aborts rather than skips, why an order matters, where a magic value
comes from. Don't narrate what the next line does.

Good examples already in the codebase:

- `packages/database/src/users/schema.ts` explains why the insert schema refines
  `id` with a function: a plain schema would make the generated id required.
- `apps/api/src/users/routes.ts` derives the 4 KiB body limit from the longest
  valid email and display name.
- `apps/worker/src/job-runner.ts` says what the first failure does and who
  restarts the worker afterwards.

## 10. Choose between cases with a table, a switch, or early returns

A ternary chooses between two values. Once there are three or more cases, a
chain of ternaries makes the reader track every condition to find one answer,
and the formatter turns it into a staircase. Pick the shape by what the cases
look like:

- A closed set of values (statuses, kinds, variants) mapped to values: a lookup
  table typed with `satisfies Record<Union, ...>`, so a new member is a compile
  error until it gets a row.
- Cases that run logic, or a discriminated union: a `switch`, exhaustive where
  the input is a union.
- Unrelated conditions checked in priority order: a small function with early
  returns, named for what it decides.

```ts
// Before
const priority =
  status === "Failed"
    ? "page"
    : status === "Delayed" || status === "Returned"
      ? "ticket"
      : status === "Shipped"
        ? "notify"
        : "none";

// After
const orderAlertPriority = {
  Failed: "page",
  Delayed: "ticket",
  Returned: "ticket",
  Shipped: "notify",
  Pending: "none",
  Delivered: "none",
} satisfies Record<OrderStatus, AlertPriority>;

const priority = orderAlertPriority[status];
```

Lint: `eslint/no-nested-ternary` rejects a ternary inside another ternary.

## Review checklist

- Can I tell what each early exit means (skip or abort) without opening a
  helper?
- Does every regex, code, and magic value have a name or a comment saying where
  it comes from?
- Does any value use `undefined` or `null` for two different situations?
- Is any discriminant tested more than once along the same path?
- Does any word name more than one thing in this function?
- Could I describe this function in one sentence without "and"?
