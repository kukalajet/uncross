import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { assert, describe, it } from "@effect/vitest";

// Versions pinned in more than one place, which must agree. Renovate updates
// each set in one grouped pull request (renovate.json5); this test fails the
// pull request, or the hand edit, that changes only some of the places.

type Manifest = {
  readonly version?: string;
  readonly packageManager?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly devEngines?: {
    readonly packageManager?: { readonly version?: string };
    readonly runtime?: { readonly version?: string };
  };
};

const repositoryUrl = new URL("../", import.meta.url);

const readText = (path: string) =>
  readFileSync(new URL(path, repositoryUrl), "utf8");

const readManifest = (path: string | URL): Manifest =>
  JSON.parse(readFileSync(path, "utf8"));

// The image build runs `pnpm check` without .github/ and deploy/, which
// .dockerignore and the Dockerfile leave out, so their files are compared only
// where the directory exists: in CI's check job and in a local checkout.
const leftOutOfImageBuild = [".github/", "deploy/"];

const filesToCompare = (paths: ReadonlyArray<string>) =>
  paths.filter((path) => {
    const directory = leftOutOfImageBuild.find((prefix) =>
      path.startsWith(prefix),
    );

    return (
      directory === undefined || existsSync(new URL(directory, repositoryUrl))
    );
  });

// The named group `value` of the pattern's first match in the file.
const capture = (path: string, pattern: RegExp) => {
  const value = pattern.exec(readText(path))?.groups?.["value"];

  assert.isDefined(value, `${path} has no match for ${pattern}`);

  return value;
};

// Fails unless every place pins the same value, listing what each one pins.
const assertSamePin = (
  subject: string,
  pins: Readonly<Record<string, string | undefined>>,
) => {
  const values = new Set(Object.values(pins));

  if (values.size === 1 && !values.has(undefined)) {
    return;
  }

  const listing = Object.entries(pins)
    .map(([place, value]) => `  ${place}: ${value ?? "(none)"}`)
    .join("\n");

  assert.fail(`${subject} is pinned differently:\n${listing}`);
};

const root = readManifest(new URL("package.json", repositoryUrl));

// vite-plus' own package.json is what pnpm installs its tools from, with exact
// `=` pins, and it names the `npm:` alias that the vite override repeats.
// toolchain.json and `vp toolchain` describe the bundled Vite instead and
// leave out @oxlint/plugins.
const vitePlus = readManifest(
  createRequire(import.meta.url).resolve("vite-plus/package.json"),
);

const vitePlusPin = (name: string) =>
  vitePlus.dependencies?.[name]?.replace(/^=/, "");

const vitePlusPlace = `vite-plus ${vitePlus.version ?? ""} dependencies`;

const viteOverridePattern = /^ {2}vite@\*: (?<value>\S+)$/m;
const vitestOverridePattern = /^ {2}vitest@\*: (?<value>\S+)$/m;

describe("the Vite+ toolchain", () => {
  it("is installed at the version package.json pins", () => {
    assert.strictEqual(
      vitePlus.version,
      root.devDependencies?.["vite-plus"],
      "node_modules holds another vite-plus than package.json pins; run pnpm install",
    );
  });

  it.each(["oxlint", "oxfmt", "@oxlint/plugins"])(
    "pins the %s that vite-plus pins",
    (name) => {
      assertSamePin(name, {
        "package.json devDependencies": root.devDependencies?.[name],
        [vitePlusPlace]: vitePlusPin(name),
      });
    },
  );

  it("pins the Vitest that vite-plus pins", () => {
    assertSamePin("vitest", {
      "package.json devDependencies": root.devDependencies?.["vitest"],
      "pnpm-workspace.yaml overrides": capture(
        "pnpm-workspace.yaml",
        vitestOverridePattern,
      ),
      [vitePlusPlace]: vitePlusPin("vitest"),
    });
  });

  it("overrides Vite with the vite-plus-core that vite-plus pins", () => {
    assertSamePin("vite", {
      "pnpm-workspace.yaml overrides": capture(
        "pnpm-workspace.yaml",
        viteOverridePattern,
      ),
      [vitePlusPlace]: vitePlusPin("vite"),
    });
  });
});

// @effect/tsgo ships a tsc for each TypeScript release it supports, and
// scripts/typecheck.ts runs the one built from the installed `typescript`.
// That tsc's version names both releases, so running the script checks that the
// type check is Effect's, built from the TypeScript that package.json pins, at
// the pinned @effect/tsgo. For a TypeScript nightly it leaves out the build
// date, 7.1.0-dev rather than 7.1.0-dev.20261023.1; the script has already
// matched the build to the installed nightly's commit.
const nightlyDatePattern = /^(?<release>\d+\.\d+\.\d+-dev)\.\d+\.\d+$/;

const typescript = root.devDependencies?.["typescript"] ?? "(none)";
const effectTsgo = root.devDependencies?.["@effect/tsgo"] ?? "(none)";

const printedTypescript =
  nightlyDatePattern.exec(typescript)?.groups?.["release"] ?? typescript;

const effectTscVersion = `Version ${printedTypescript}+effect-tsgo.${effectTsgo}`;

// Runs `node <script> --version`.
const printVersion = (script: string) =>
  spawnSync(process.execPath, [script, "--version"], {
    cwd: repositoryUrl,
    encoding: "utf8",
  });

describe("the type check", () => {
  it("runs the Effect tsc built from the pinned TypeScript", () => {
    const { stdout, stderr } = printVersion("scripts/typecheck.ts");

    const advice = [
      `pnpm typecheck must run the tsc that @effect/tsgo ${effectTsgo} builds from typescript ${typescript}.`,
      "Run pnpm install if node_modules is out of date. Otherwise update both together, to an @effect/tsgo release that ships a tsc for that TypeScript: its README lists them under Supported Package Versions.",
      `scripts/typecheck.ts stderr: ${stderr.trim() || "(empty)"}`,
    ];

    assert.strictEqual(stdout.trim(), effectTscVersion, advice.join("\n"));
  });

  // Zed and VS Code run the installed `typescript` package's tsc, which
  // `prepare` replaces with the same Effect build (`effect-tsgo patch`).
  it("is the tsc that editors run", () => {
    const { stdout } = printVersion("node_modules/typescript/bin/tsc");

    assert.strictEqual(
      stdout.trim(),
      effectTscVersion,
      "Editors would show plain TypeScript's errors, without Effect's. pnpm install skips `prepare` when nothing changed: run pnpm prepare.",
    );
  });
});

const nodeImagePattern = /^ARG NODE_IMAGE=node:(?<value>[^-@\s]+)-/m;
const pnpmInstallPattern = /npm install --global pnpm@(?<value>\S+)/;

describe("the Dockerfile", () => {
  it("runs the Node version that devEngines.runtime pins", () => {
    assertSamePin("Node", {
      "package.json devEngines.runtime": root.devEngines?.runtime?.version,
      "Dockerfile NODE_IMAGE": capture("Dockerfile", nodeImagePattern),
    });
  });

  it("installs the pnpm version that package.json pins", () => {
    assertSamePin("pnpm", {
      "package.json packageManager": root.packageManager?.replace(/^pnpm@/, ""),
      "package.json devEngines.packageManager":
        root.devEngines?.packageManager?.version,
      "Dockerfile npm install": capture("Dockerfile", pnpmInstallPattern),
    });
  });
});

const postgresFiles = [
  ".github/workflows/ci.yml",
  "docker-compose.yml",
  "deploy/vps/compose.yml",
];

// Every file that names an image pinned by digest, the docs included.
const imageFiles = [
  ...postgresFiles,
  "Dockerfile",
  "scripts/check-static.sh",
  "scripts/scan-image.sh",
  "README.md",
  "deploy/vps/README.md",
];

const postgresImagePattern = /^ +image: postgres:\S+@sha256:[0-9a-f]{64}$/m;

const imageReferencePattern =
  /(?<repository>[\w./-]+):[\w.-]+@sha256:[0-9a-f]{64}/g;

// Each image repository's references, keyed by file and line.
const imageReferences = () => {
  const references = new Map<string, Record<string, string>>();

  for (const path of filesToCompare(imageFiles)) {
    const text = readText(path);

    for (const match of text.matchAll(imageReferencePattern)) {
      const repository = match.groups?.["repository"] ?? "";
      const line = text.slice(0, match.index).split("\n").length;

      references.set(repository, {
        ...references.get(repository),
        [`${path}:${line}`]: match[0],
      });
    }
  }

  return references;
};

describe("the Docker images", () => {
  it("pin PostgreSQL by digest in CI and both Compose files", () => {
    for (const path of filesToCompare(postgresFiles)) {
      assert.match(
        readText(path),
        postgresImagePattern,
        `${path} has no postgres:<tag>@sha256:<digest> image`,
      );
    }
  });

  it("pin each image to one tag and digest in every file", () => {
    const references = imageReferences();

    assert.isTrue(references.has("postgres"), "found no postgres image");

    for (const [repository, places] of references) {
      assertSamePin(repository, places);
    }
  });
});

// The scan step from its `uses:` line to its last setting, without the image,
// which each workflow builds under its own tag.
const scanStepPattern =
  /^(?<indent> +)uses: anchore\/scan-action@.*\n(?:\k<indent>.*\n)*/m;

const scanImagePattern = /^ +image: .*\n/m;

const scanWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/scan.yml",
];

const grypeVersionPattern = /^ +grype-version: (?<value>\S+)$/m;
const grypeImagePattern = /^grype_image=anchore\/grype:(?<value>[^@\s]+)@/m;

describe("the image scan", () => {
  it("runs the same Grype in CI and in scan-image.sh", () => {
    assertSamePin("Grype", {
      ...Object.fromEntries(
        filesToCompare(scanWorkflows).map((path) => [
          `${path} grype-version`,
          capture(path, grypeVersionPattern),
        ]),
      ),
      "scripts/scan-image.sh image": capture(
        "scripts/scan-image.sh",
        grypeImagePattern,
      ),
    });
  });

  it("runs the same action, Grype and settings in ci.yml and scan.yml", () => {
    const [first, ...others] = filesToCompare(scanWorkflows).map((path) => ({
      path,
      step: scanStepPattern
        .exec(readText(path))?.[0]
        .replace(scanImagePattern, ""),
    }));

    for (const other of others) {
      assert.isDefined(other.step, `${other.path} has no anchore/scan-action`);

      assert.strictEqual(
        other.step,
        first?.step,
        `${other.path} scans differently from ${first?.path ?? ""}`,
      );
    }
  });
});
