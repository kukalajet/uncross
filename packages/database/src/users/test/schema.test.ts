import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { UserInsertRowSchema, UserRowSchema } from "../schema.ts";

const strict = { errors: "all", onExcessProperty: "error" } as const;
const decodeRow = Schema.decodeUnknownSync(UserRowSchema, strict);
const decodeInsert = Schema.decodeUnknownSync(UserInsertRowSchema, strict);

const row = {
  id: "d5b9d3de-fda5-4a78-b8a5-2f3b60634d95",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  createdAt: new Date("2026-08-09T12:00:00.000Z"),
};

describe("user row schemas", () => {
  it("decode a stored row with the domain rules", () => {
    assert.deepStrictEqual(
      decodeRow({ ...row, email: " ada@example.com " }),
      row,
    );

    assert.throws(() => decodeRow({ ...row, id: "not-a-uuid" }));
    assert.throws(() => decodeRow({ ...row, displayName: "   " }));
    assert.throws(() => decodeRow({ ...row, password: "secret" }));
  });

  it("leave generated columns optional on insert", () => {
    const insert = { email: row.email, displayName: row.displayName };

    assert.deepStrictEqual(decodeInsert(insert), insert);

    assert.deepStrictEqual(decodeInsert({ ...insert, id: row.id }), {
      ...insert,
      id: row.id,
    });

    assert.throws(() => decodeInsert({ ...insert, id: "not-a-uuid" }));
    assert.throws(() => decodeInsert({ ...insert, email: "not-an-email" }));
  });
});
