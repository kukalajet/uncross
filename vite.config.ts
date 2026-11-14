import { readFileSync } from "node:fs";

import { defineConfig } from "vite-plus";
import type { OxfmtConfig } from "vite-plus/fmt";
import type { OxlintConfig } from "vite-plus/lint";

// Lint and format rules live in .oxlintrc.json and .oxfmtrc.json so editors and
// the standalone oxlint and oxfmt binaries apply the same rules as `vp check`.
// Both tools validate these files against their own schemas when loading them.
const readJson = (fileName: string) =>
  JSON.parse(readFileSync(new URL(fileName, import.meta.url), "utf8"));

const fmt: OxfmtConfig = readJson("./.oxfmtrc.json");
const lint: OxlintConfig = readJson("./.oxlintrc.json");

const config = defineConfig({
  fmt,
  lint,
  staged: {
    "*": "vp check --fix",
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "apps/**/*.test.ts",
            "packages/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "postgres",
          include: ["apps/**/*.postgres.ts", "packages/**/*.postgres.ts"],
          setupFiles: ["packages/database/src/test/postgres.setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});

export { config as default };
