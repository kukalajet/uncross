import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

// Built from parts so that running the script never rewrites the script.
const sourceProjectName = ["node", "effect"].join("-");

// Valid as an npm scope, a Docker image name, and (with `_` for `-`) a
// PostgreSQL identifier that needs no quoting: it starts with a letter and has
// at most 63 bytes. The runtime role's default name adds `_app` to it
// (APP_DATABASE_USER in .env.example), and `migrate` accepts only such a name.
const projectNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const maxProjectNameLength = 63 - "_app".length;

// PostgreSQL reserves role names that start with `pg_`, which `pg` or a name
// starting with `pg-` would give the database owner or the runtime role.
const reservedProjectNamePattern = /^pg(?:-|$)/;

const ignoredDirectoryNames = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

// Paths relative to the repository root. `.vite-hooks/_` holds the Git hook
// shims that `vp config` generates.
const ignoredDirectoryPaths = new Set([join(".vite-hooks", "_")]);

// Registry packages sit two spaces deep in the lockfile's `packages` and
// `snapshots` sections. Workspace packages are only linked, never listed there.
const registryScopePattern = /^ {2}'(@[a-z0-9-]+)\//gm;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const validateProjectName = (projectName: string): string => {
  const isValidName = projectNamePattern.test(projectName);
  const isReservedName = reservedProjectNamePattern.test(projectName);

  if (projectName.length > maxProjectNameLength || !isValidName) {
    throw new Error(
      `Project name must be 1-${maxProjectNameLength} characters of lowercase letters or digits separated by single hyphens, starting with a letter`,
    );
  }

  if (isReservedName) {
    throw new Error(
      "Project name must not be pg or start with pg-: PostgreSQL reserves role names that start with pg_",
    );
  }

  return projectName;
};

// The package scope must not be one a dependency already uses, or lint would
// treat imports from that dependency as this project's own packages.
const assertScopeIsUnused = async (rootPath: string, projectName: string) => {
  const lockfilePath = join(rootPath, "pnpm-lock.yaml");
  if (!existsSync(lockfilePath)) return;

  const lockfile = await readFile(lockfilePath, "utf8");

  const scopes = new Set(
    Array.from(lockfile.matchAll(registryScopePattern), ([, scope]) => scope),
  );

  if (scopes.has(`@${projectName}`)) {
    throw new Error(`A dependency already uses the @${projectName} scope`);
  }
};

// Rewrites the three forms of the template name: the repository name, the
// database name, and the package scope. It is one pass, so the text it inserts
// is never rewritten again. The new names are matched as themselves, so where
// one contains the template name, running init again changes nothing.
const replaceTemplateIdentifiers = (
  source: string,
  projectName: string,
): string => {
  const sourceDatabaseName = sourceProjectName.replaceAll("-", "_");
  const databaseName = projectName.replaceAll("-", "_");

  const replacements = new Map([
    [projectName, projectName],
    [databaseName, databaseName],
    [`${sourceProjectName}-template`, projectName],
    [sourceDatabaseName, databaseName],
    [sourceProjectName, projectName],
  ]);

  // Longest first, so the repository name wins over the bare template name
  // where both match. Validated names hold no regex syntax.
  const identifiers = [...replacements.keys()].toSorted(
    (left, right) => right.length - left.length,
  );

  const identifierPattern = new RegExp(identifiers.join("|"), "g");

  return source.replaceAll(
    identifierPattern,
    (identifier) => replacements.get(identifier) ?? identifier,
  );
};

// Undefined for a binary file: one with a NUL byte or invalid UTF-8.
const decodeText = (contents: Uint8Array): string | undefined => {
  if (contents.includes(0)) return undefined;

  try {
    return textDecoder.decode(contents);
  } catch {
    return undefined;
  }
};

const isIgnoredDirectory = (rootPath: string, directoryPath: string) =>
  ignoredDirectoryNames.has(basename(directoryPath)) ||
  ignoredDirectoryPaths.has(relative(rootPath, directoryPath));

// Rewrites `filePath` when it is a text file that names the template. Returns
// whether it changed.
const replaceInFile = async (filePath: string, projectName: string) => {
  const source = decodeText(await readFile(filePath));
  if (source === undefined) return false;

  const updated = replaceTemplateIdentifiers(source, projectName);
  if (updated === source) return false;

  await writeFile(filePath, updated);

  return true;
};

// Symbolic links are neither files nor directories here, so they are left
// alone along with whatever they point to. Returns the changed files' paths
// relative to `rootPath`.
const replaceInDirectory = async (
  rootPath: string,
  directoryPath: string,
  projectName: string,
): Promise<Array<string>> => {
  const changedPaths: Array<string> = [];

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDirectory(rootPath, entryPath)) continue;

      changedPaths.push(
        ...(await replaceInDirectory(rootPath, entryPath, projectName)),
      );
    } else if (
      entry.isFile() &&
      (await replaceInFile(entryPath, projectName))
    ) {
      changedPaths.push(relative(rootPath, entryPath));
    }
  }

  return changedPaths;
};

// Renames the template in every text file under `rootPath` and returns the
// changed files' paths relative to `rootPath`.
const initializeTemplate = async (
  rootPath: string,
  projectName: string,
): Promise<ReadonlyArray<string>> => {
  validateProjectName(projectName);
  await assertScopeIsUnused(rootPath, projectName);

  return await replaceInDirectory(rootPath, rootPath, projectName);
};

// A name of a different length changes line lengths, so Markdown, YAML and
// imports need re-wrapping. `vp fmt` skips the files its config ignores or
// cannot format. `pnpm run` puts `vp` on the PATH.
const formatFiles = (rootPath: string, filePaths: ReadonlyArray<string>) => {
  const result = spawnSync(
    "vp",
    ["fmt", "--no-error-on-unmatched-pattern", ...filePaths],
    { cwd: rootPath, stdio: "inherit" },
  );

  return result.error === undefined && result.status === 0;
};

const main = async (args: ReadonlyArray<string>) => {
  const [projectName, extraArgument] = args;

  if (projectName === undefined || extraArgument !== undefined) {
    console.error("Usage: pnpm run init <project-name>");
    process.exitCode = 1;

    return;
  }

  try {
    const rootPath = join(import.meta.dirname, "..");
    const changedPaths = await initializeTemplate(rootPath, projectName);

    if (changedPaths.length === 0) {
      console.log("No template identifiers found");

      return;
    }

    console.log(`Initialized ${projectName} in ${changedPaths.length} files`);

    if (!formatFiles(rootPath, changedPaths)) {
      console.error("Could not format the renamed files; run `pnpm fix`");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main(process.argv.slice(2));
}

export { initializeTemplate, replaceTemplateIdentifiers, validateProjectName };
