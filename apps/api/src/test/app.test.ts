import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { OpenApi } from "effect/http-api";

import { DatabaseHealth, UserRepository } from "@node-effect/application";

import { accessLog } from "../access-log.ts";
import { Api } from "../api-contract.ts";
import { ApiRoutes } from "../app.ts";

const RequestServicesTest = Layer.mergeAll(
  Layer.mock(DatabaseHealth, { check: Effect.void }),
  Layer.mock(UserRepository, { list: () => Effect.succeed([]) }),
);

const TestRoutes = ApiRoutes.pipe(
  HttpRouter.provideRequest(RequestServicesTest),
  Layer.provide(HttpServer.layerServices),
);

const serve = () =>
  HttpRouter.toWebHandler(TestRoutes, { disableLogger: true });

const get = (path: string) => new Request(`http://localhost${path}`);

// The fake repository has no findById, and a member that Layer.mock was not
// given dies when used, so reading this user is a handler that dies.
const dyingRequest = () => get("/users/d5b9d3de-fda5-4a78-b8a5-2f3b60634d95");

// Every operation the API serves. A new endpoint must be added here, which
// makes the checks below cover it.
const documentedOperations = [
  { method: "get", path: "/health/live", success: 200, errors: [] },
  { method: "get", path: "/health/ready", success: 200, errors: [503] },
  { method: "get", path: "/health", success: 200, errors: [503] },
  { method: "get", path: "/users", success: 200, errors: [400, 500] },
  {
    method: "get",
    path: "/users/{id}",
    success: 200,
    errors: [400, 404, 500],
  },
  {
    method: "post",
    path: "/users",
    success: 201,
    errors: [400, 409, 413, 415, 500],
  },
] as const;

const errorEnvelopeSchema = (code: string, message: string) => ({
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", enum: [code] },
        message: { type: "string", enum: [message] },
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["error"],
  additionalProperties: false,
});

describe("API composition", () => {
  it("serves health, the OpenAPI document, and Swagger UI together", async () => {
    const { dispose, handler } = serve();

    try {
      const live = await handler(get("/health/live"));
      assert.strictEqual(live.status, 200);
      assert.deepStrictEqual(await live.json(), { status: "ok" });

      for (const path of ["/health/ready", "/health"]) {
        const response = await handler(get(path));
        assert.strictEqual(response.status, 200);

        assert.deepStrictEqual(await response.json(), {
          status: "ok",
          database: "ok",
        });
      }

      const users = await handler(get("/users"));
      assert.strictEqual(users.status, 200);
      assert.deepStrictEqual(await users.json(), { users: [] });

      const openapi = await handler(get("/openapi.json"));
      assert.strictEqual(openapi.status, 200);

      assert.match(
        openapi.headers.get("content-type") ?? "",
        /^application\/json/,
      );

      const docs = await handler(get("/docs"));
      assert.strictEqual(docs.status, 200);
      assert.match(docs.headers.get("content-type") ?? "", /^text\/html/);
    } finally {
      await dispose();
    }
  });

  it("answers 404 NOT_FOUND for a route the contract does not declare", async () => {
    const { dispose, handler } = serve();

    try {
      for (const request of [
        get("/unknown"),
        new Request("http://localhost/users", { method: "DELETE" }),
        new Request("http://localhost/users", { method: "OPTIONS" }),
      ]) {
        const response = await handler(request);

        assert.strictEqual(response.status, 404);

        assert.deepStrictEqual(await response.json(), {
          error: { code: "NOT_FOUND", message: "Route not found" },
        });
      }
    } finally {
      await dispose();
    }
  });

  it("answers 500 INTERNAL_ERROR when a handler dies", async () => {
    const { dispose, handler } = serve();

    try {
      const response = await handler(dyingRequest());

      assert.strictEqual(response.status, 500);

      assert.deepStrictEqual(await response.json(), {
        error: {
          code: "INTERNAL_ERROR",
          message: "The request could not be completed",
        },
      });
    } finally {
      await dispose();
    }
  });

  it("logs both as before: only the defect with its cause", async () => {
    const lines: Array<string> = [];

    const logger = Logger.map(Logger.formatJson, (line) => {
      lines.push(line);
    });

    const { dispose, handler } = HttpRouter.toWebHandler(
      Layer.mergeAll(TestRoutes, Logger.layer([logger])),
      { disableLogger: true, middleware: accessLog },
    );

    try {
      await handler(get("/unknown"));
      await handler(dyingRequest());
    } finally {
      await dispose();
    }

    const [unmatched, died] = lines.map((line) => JSON.parse(line));

    assert.deepStrictEqual(
      [unmatched.level, unmatched.annotations.status, unmatched.cause],
      ["INFO", 404, undefined],
    );

    assert.deepStrictEqual(
      [died.level, died.annotations.status],
      ["ERROR", 500],
    );

    assert.include(died.cause, "findById");
  });
});

describe("OpenAPI document", () => {
  it("is served exactly as generated from the contract", async () => {
    const { dispose, handler } = serve();

    try {
      const response = await handler(get("/openapi.json"));

      assert.deepStrictEqual(await response.json(), OpenApi.fromApi(Api));
    } finally {
      await dispose();
    }
  });

  it("documents every operation with a unique ID and its responses", () => {
    const specification = OpenApi.fromApi(Api);
    const operationIds = new Set<string>();

    assert.strictEqual(specification.openapi, "3.1.0");
    assert.strictEqual(specification.info.title, "node-effect-template API");

    assert.deepStrictEqual(
      Object.keys(specification.paths).sort(),
      [...new Set(documentedOperations.map(({ path }) => path))].sort(),
    );

    for (const { method, path, success, errors } of documentedOperations) {
      const name = `${method.toUpperCase()} ${path}`;
      const operation = specification.paths[path]?.[method];
      assert.exists(operation, name);

      assert.isFalse(operationIds.has(operation.operationId), name);
      operationIds.add(operation.operationId);

      assert.deepStrictEqual(
        Object.keys(operation.responses).sort(),
        [success, ...errors].map(String).sort(),
        name,
      );
    }

    assert.strictEqual(operationIds.size, documentedOperations.length);
  });

  it("documents the public error envelope with literal codes", () => {
    const specification = OpenApi.fromApi(Api);
    const createUser = specification.paths["/users"]?.post;
    assert.exists(createUser);

    for (const { status, code, message } of [
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "The request payload is invalid",
      },
      {
        status: 409,
        code: "USER_ALREADY_EXISTS",
        message: "A user with this email already exists",
      },
      {
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The request payload is too large",
      },
      {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request content type must be application/json",
      },
      {
        status: 500,
        code: "DATABASE_ERROR",
        message: "The database operation could not be completed",
      },
    ]) {
      assert.deepStrictEqual(
        createUser.responses[status]?.content?.["application/json"]?.schema,
        errorEnvelopeSchema(code, message),
        String(status),
      );
    }

    const readiness = specification.paths["/health/ready"]?.get;
    assert.exists(readiness);
    assert.strictEqual(readiness.operationId, "health.ready");

    assert.deepStrictEqual(
      readiness.responses[503]?.content?.["application/json"]?.schema,
      errorEnvelopeSchema(
        "DATABASE_UNAVAILABLE",
        "The database is unavailable",
      ),
    );
  });
});

describe("Swagger UI", () => {
  it("embeds the same document the API serves", async () => {
    const { dispose, handler } = serve();

    try {
      const html = await (await handler(get("/docs"))).text();

      const embedded = html.match(
        /<script id="swagger-spec" type="application\/json">\s*([\s\S]*?)\s*<\/script>/,
      )?.[1];

      assert.exists(embedded);

      assert.deepStrictEqual(JSON.parse(embedded), OpenApi.fromApi(Api));
    } finally {
      await dispose();
    }
  });
});
