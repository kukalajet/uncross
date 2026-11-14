import { existsSync } from "node:fs";
import { join } from "node:path";

// `pnpm test:postgres` runs without `--env-file`, so read the repository's
// .env the way the `dev:*` scripts do. Variables already set take precedence.
const envFile = join(import.meta.dirname, "../../../../.env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

if (!process.env["DATABASE_URL"]) {
  throw new Error(
    "DATABASE_URL is required for PostgreSQL tests. Set it in the environment or in .env (see .env.example).",
  );
}
