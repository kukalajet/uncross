// Checks a running API end to end against its PostgreSQL. It needs nothing but
// Node, so it also runs inside the production image. Run it against a freshly
// migrated database: it creates ada@example.com and expects her to be the only
// user.
//
//   API_URL=http://127.0.0.1:8000 node scripts/smoke-api.ts
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";

const baseUrl = process.env["API_URL"] ?? "http://127.0.0.1:8000";

const request = async (
  path: string,
  status: number,
  init?: RequestInit,
): Promise<Response> => {
  const response = await fetch(new URL(path, baseUrl), init);
  strictEqual(response.status, status, `${init?.method ?? "GET"} ${path}`);

  return response;
};

// Checks the status and discards the body.
const expectStatus = async (
  path: string,
  status: number,
  init?: RequestInit,
) => {
  await (await request(path, status, init)).body?.cancel();
};

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const postUser = (body: string | Uint8Array): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

deepStrictEqual(await (await request("/health/live", 200)).json(), {
  status: "ok",
});

for (const path of ["/health/ready", "/health"]) {
  deepStrictEqual(await (await request(path, 200)).json(), {
    status: "ok",
    database: "ok",
  });
}

const openapi: unknown = await (await request("/openapi.json", 200)).json();
ok(isObject(openapi) && "openapi" in openapi && "paths" in openapi);
strictEqual(openapi.openapi, "3.1.0");
ok(isObject(openapi.paths) && "/users" in openapi.paths, "lists /users");
const docs = await request("/docs", 200);
match(docs.headers.get("content-type") ?? "", /^text\/html/);
await docs.body?.cancel();

const input = { email: "ada@example.com", displayName: "Ada Lovelace" };
const create = postUser(JSON.stringify(input));
const created: unknown = await (await request("/users", 201, create)).json();
ok(isObject(created) && "id" in created && "createdAt" in created);
const { id, createdAt } = created;
ok(typeof id === "string" && typeof createdAt === "string", "a user");
const user = { id, ...input, createdAt };
deepStrictEqual(created, user);
match(user.id, /^[0-9a-f-]{36}$/);
strictEqual(new Date(user.createdAt).toISOString(), user.createdAt);

deepStrictEqual(await (await request(`/users/${user.id}`, 200)).json(), user);
deepStrictEqual(await (await request("/users", 200)).json(), { users: [user] });

deepStrictEqual(await (await request("/users?limit=1", 200)).json(), {
  users: [user],
});

await expectStatus("/users", 409, create);
await expectStatus("/users/not-a-uuid", 400);
await expectStatus("/users?limit=0", 400);
await expectStatus("/users?limit=101", 400);
await expectStatus("/users/00000000-0000-4000-8000-000000000000", 404);
await expectStatus("/users", 400, postUser("{"));

await expectStatus(
  "/users",
  400,
  postUser(JSON.stringify({ ...input, email: "grace@example.com", admin: 1 })),
);

await expectStatus(
  "/users",
  413,
  postUser(JSON.stringify({ ...input, displayName: "a".repeat(64 * 1024) })),
);

// A second user, whom none of the requests below may create.
const grace = { ...input, email: "grace@example.com" };

// Latin-1 writes U+00FF and U+00FE as the bytes 0xff and 0xfe, which UTF-8
// never uses, and JSON.stringify writes a lone surrogate as its escape,
// \ud800.
for (const body of [
  Buffer.from(
    JSON.stringify({ ...grace, displayName: "a\u00ff\u00feb" }),
    "latin1",
  ),
  JSON.stringify({ ...grace, displayName: "a\ud800b" }),
]) {
  await expectStatus("/users", 400, postUser(body));
}

await expectStatus("/users", 415, {
  ...postUser(JSON.stringify(grace)),
  headers: { "content-type": "text/plain" },
});

const notFound = { error: { code: "NOT_FOUND", message: "Route not found" } };
deepStrictEqual(await (await request("/not-a-route", 404)).json(), notFound);

deepStrictEqual(
  await (await request("/users", 404, { method: "DELETE" })).json(),
  notFound,
);

console.log("API smoke checks passed against PostgreSQL");
