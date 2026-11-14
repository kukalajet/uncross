import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run Drizzle Kit");
}

const config = defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  // Every feature's table file, so a new feature's `schema.ts` reaches
  // `pnpm db:generate` and `pnpm db:verify` without a change here.
  schema: "./packages/database/src/*/schema.ts",
  dbCredentials: {
    url: databaseUrl,
  },
});

export { config as default };
