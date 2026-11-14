import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  CreateUserSchema,
  DisplayName,
  Email,
  UserId,
} from "@node-effect/domain";

const decodeEmail = Schema.decodeUnknownSync(Email);
const decodeDisplayName = Schema.decodeUnknownSync(DisplayName);
const decodeUserId = Schema.decodeUnknownSync(UserId);
const decodeCreateUser = Schema.decodeUnknownSync(CreateUserSchema);

describe("user schemas", () => {
  it("trim email addresses and display names", () => {
    assert.strictEqual(decodeEmail("  ada@example.com  "), "ada@example.com");
    assert.strictEqual(decodeDisplayName("  Ada Lovelace  "), "Ada Lovelace");
  });

  it("reject malformed email addresses", () => {
    for (const email of ["not-an-email", "ada@example", "a da@example.com"]) {
      assert.throws(() => decodeEmail(email));
    }

    assert.throws(() => decodeEmail(`${"a".repeat(310)}@example.com`));
  });

  // PostgreSQL text cannot store NUL, so it must fail here as invalid input
  // rather than in the database as a server error.
  it("reject control characters in email addresses and display names", () => {
    for (const email of [
      "a\u0000b@example.com",
      "ada@exa\u0000mple.com",
      "ada@example.c\u0007om",
    ]) {
      assert.throws(() => decodeEmail(email));
    }

    for (const displayName of ["a\u0000b", "Ada\nLovelace", "Ada\u007f"]) {
      assert.throws(() => decodeDisplayName(displayName));
    }

    assert.strictEqual(decodeDisplayName("Zoë 李"), "Zoë 李");
  });

  it("reject blank and overlong display names", () => {
    assert.throws(() => decodeDisplayName("   "));
    assert.throws(() => decodeDisplayName("a".repeat(101)));
  });

  it("accept only UUID user ids", () => {
    const id = "d5b9d3de-fda5-4a78-b8a5-2f3b60634d95";

    assert.strictEqual(decodeUserId(id), id);
    assert.throws(() => decodeUserId("not-a-uuid"));
  });

  it("decode a create-user command from untrimmed input", () => {
    assert.deepStrictEqual(
      decodeCreateUser({
        email: " ada@example.com ",
        displayName: " Ada Lovelace ",
      }),
      { email: "ada@example.com", displayName: "Ada Lovelace" },
    );
  });
});
