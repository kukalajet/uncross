import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
} from "@effect/vitest";

import {
  initializeTemplate,
  replaceTemplateIdentifiers,
  validateProjectName,
} from "./init-template.ts";

// Built from parts, like the script's own source name, so that initializing
// the repository leaves these tests intact.
const templateName = ["node", "effect"].join("-");
const databaseName = templateName.replaceAll("-", "_");

describe("replaceTemplateIdentifiers", () => {
  it("replaces every project identifier form", () => {
    const source = [
      `@${templateName}/api`,
      `${templateName}-template`,
      `${templateName}-template:local`,
      `postgresql://${databaseName}@127.0.0.1:5432/${databaseName}`,
      `APP_DATABASE_USER=${databaseName}_app`,
      "Node Effect backend template",
    ].join("\n");

    assert.strictEqual(
      replaceTemplateIdentifiers(source, "acme-service"),
      [
        "@acme-service/api",
        "acme-service",
        "acme-service:local",
        "postgresql://acme_service@127.0.0.1:5432/acme_service",
        "APP_DATABASE_USER=acme_service_app",
        "Node Effect backend template",
      ].join("\n"),
    );
  });

  it("leaves a project name that contains the template name intact", () => {
    const source = [
      `"name": "${templateName}-template"`,
      `image ${templateName}-template:local`,
      `@${templateName}/config`,
      `database ${databaseName}`,
    ].join("\n");

    for (const projectName of [`${templateName}-api`, `my-${templateName}`]) {
      const databaseProjectName = projectName.replaceAll("-", "_");
      const renamed = replaceTemplateIdentifiers(source, projectName);

      assert.strictEqual(
        renamed,
        [
          `"name": "${projectName}"`,
          `image ${projectName}:local`,
          `@${projectName}/config`,
          `database ${databaseProjectName}`,
        ].join("\n"),
      );
    }
  });

  it("changes nothing when run again with the same name", () => {
    const source = `@${templateName}/api ${templateName}-template ${databaseName}`;

    for (const projectName of ["acme-service", `${templateName}-api`]) {
      const renamed = replaceTemplateIdentifiers(source, projectName);

      assert.strictEqual(
        replaceTemplateIdentifiers(renamed, projectName),
        renamed,
      );
    }
  });
});

describe("validateProjectName", () => {
  // 59, so that the runtime role's `<name>_app` fits PostgreSQL's 63 bytes.
  it("accepts lowercase kebab-case names up to 59 characters", () => {
    for (const projectName of [
      "api",
      "acme-service-2",
      "a2-billing",
      "pgadmin",
      "a".repeat(59),
    ]) {
      assert.strictEqual(validateProjectName(projectName), projectName);
    }
  });

  it("rejects names that cannot be package, image, and database names", () => {
    for (const projectName of [
      "",
      "Acme",
      "acme_service",
      "acme service",
      "-acme",
      "acme-",
      "acme--service",
      "a".repeat(60),
      // An unquoted PostgreSQL identifier cannot start with a digit.
      "2fa-service",
      "9",
      // PostgreSQL reserves role names that start with pg_.
      "pg",
      "pg-tools",
    ]) {
      assert.throws(() => validateProjectName(projectName));
    }
  });
});

describe("initializeTemplate", () => {
  let root = "";

  const write = async (path: string, contents: string | Uint8Array) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  };

  const read = (path: string) => readFile(join(root, path), "utf8");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "init-template-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rewrites text files and skips generated, vendored, and binary files", async () => {
    const named = `@${templateName}/domain ${databaseName}`;
    const binary = new Uint8Array([0, ...new TextEncoder().encode(named)]);

    await write("package.json", `{ "name": "${templateName}-template" }`);
    await write("packages/domain/package.json", named);
    await write("pnpm-lock.yaml", named);
    await write("README.md", "Nothing to rename");
    await write("image.bin", binary);

    for (const ignored of [
      ".git/config",
      "node_modules/x/index.js",
      "apps/api/node_modules/y.js",
      "coverage/index.html",
      "dist/main.js",
      ".vite-hooks/_/pre-commit",
    ]) {
      await write(ignored, named);
    }

    const changedPaths = await initializeTemplate(root, "acme-service");

    assert.deepStrictEqual(changedPaths.toSorted(), [
      "package.json",
      join("packages", "domain", "package.json"),
      "pnpm-lock.yaml",
    ]);

    assert.strictEqual(
      await read("package.json"),
      `{ "name": "acme-service" }`,
    );

    assert.strictEqual(
      await read("packages/domain/package.json"),
      "@acme-service/domain acme_service",
    );

    assert.strictEqual(
      await read("pnpm-lock.yaml"),
      "@acme-service/domain acme_service",
    );

    assert.deepStrictEqual(
      new Uint8Array(await readFile(join(root, "image.bin"))),
      binary,
    );

    assert.strictEqual(await read(".git/config"), named);
    assert.strictEqual(await read("apps/api/node_modules/y.js"), named);
    assert.strictEqual(await read(".vite-hooks/_/pre-commit"), named);
  });

  it("rejects an invalid name before touching any file", async () => {
    await write("package.json", `${templateName}-template`);

    await expect(initializeTemplate(root, "Not Valid")).rejects.toThrow(
      "Project name must be",
    );

    assert.strictEqual(await read("package.json"), `${templateName}-template`);
  });

  it("rejects a name whose scope a dependency already uses", async () => {
    const lockfile = [
      "importers:",
      "  packages/domain:",
      "    dependencies:",
      `      '@${templateName}/application':`,
      "        version: link:../application",
      "packages:",
      "  '@effect/platform-node@4.0.6':",
      "    resolution: {}",
    ].join("\n");

    await write("pnpm-lock.yaml", lockfile);

    await expect(initializeTemplate(root, "effect")).rejects.toThrow(
      "@effect scope",
    );

    assert.strictEqual(await read("pnpm-lock.yaml"), lockfile);

    await initializeTemplate(root, "acme-service");
    await initializeTemplate(root, "acme-service");
  });
});
