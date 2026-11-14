import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

import {
  blockTypes,
  isGuard,
  isSeparatedBlock,
  reportMissingBlankLine,
  type StatementSibling,
} from "../shared/blank-lines.ts";

// Block statements belong to blank-line-around-blocks, and import-order owns
// the spacing between imports.
function isMultilineStatement(node: StatementSibling): boolean {
  return node.loc.end.line > node.loc.start.line &&
    !blockTypes.has(node.type) && node.type !== "ImportDeclaration";
}

function declaredNames(node: StatementSibling): ReadonlySet<string> {
  switch (node.type) {
    case "VariableDeclaration":
      return new Set(
        node.declarations.flatMap((declarator) =>
          declarator.id.type === "Identifier" ? [declarator.id.name] : []
        ),
      );
    case "ClassDeclaration":
    case "FunctionDeclaration":
      return new Set(node.id === null ? [] : [node.id.name]);
    default:
      return new Set();
  }
}

function leftmostName(
  name: ESTree.TSTypeName | ESTree.TSImportType,
): string | undefined {
  if (name.type === "Identifier") return name.name;
  if (name.type === "TSQualifiedName") return leftmostName(name.left);

  return undefined;
}

// Collects the names a type reads through `typeof`, such as `User` in
// `typeof User.Type` or `Schema.Schema.Type<typeof User>`.
function typeQueryNames(node: object, names: Set<string>): Set<string> {
  if ("type" in node && node.type === "TSTypeQuery") {
    // SAFETY: oxc's TSTypeQuery is the only node with this `type`.
    const name = leftmostName((node as ESTree.TSTypeQuery).exprName);
    if (name !== undefined) names.add(name);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (value === null || typeof value !== "object") continue;

    const children: ReadonlyArray<unknown> = Array.isArray(value)
      ? value
      : [value];
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        typeQueryNames(child, names);
      }
    }
  }

  return names;
}

// `type User = typeof User.Type` names the value declared just above it, so
// the pair stays together and is spaced as one statement.
function isAttachedAlias(
  node: StatementSibling,
  previous: StatementSibling,
): boolean {
  if (node.type !== "TSTypeAliasDeclaration") return false;

  const names = declaredNames(previous);

  return [...typeQueryNames(node.typeAnnotation, new Set())].some((name) =>
    names.has(name)
  );
}

function endsMultilineStatement(
  siblings: ReadonlyArray<StatementSibling>,
  index: number,
): boolean {
  const node = siblings[index];
  const previous = siblings[index - 1];
  if (node === undefined) return false;
  if (isMultilineStatement(node)) return true;

  return previous !== undefined && isAttachedAlias(node, previous) &&
    endsMultilineStatement(siblings, index - 1);
}

function checkSiblings(
  context: Context,
  siblings: ReadonlyArray<StatementSibling>,
): void {
  siblings.forEach((node, index) => {
    const previous = siblings[index - 1];
    if (previous === undefined) return;

    // blank-line-before-return owns the gap before a return, and
    // blank-line-around-blocks the gaps around a multi-line block. A guard
    // stays with the statement whose result it checks.
    const isOwnedElsewhere = node.type === "ReturnStatement" ||
      isSeparatedBlock(previous) || isSeparatedBlock(node) || isGuard(node);
    if (isOwnedElsewhere || isAttachedAlias(node, previous)) return;

    const needsBlankLine = endsMultilineStatement(siblings, index - 1) ||
      isMultilineStatement(node);
    if (needsBlankLine) {
      reportMissingBlankLine(context, previous, node, "blankLine");
    }
  });
}

const blankLineAroundMultilineStatementsRule = defineRule({
  meta: {
    type: "layout",
    docs: {
      description:
        "Require blank lines around multi-line statements, except a type alias that reads the declaration above it.",
    },
    fixable: "whitespace",
    messages: {
      blankLine:
        "Separate multi-line statements from their neighbours with a blank line.",
    },
  },
  createOnce(context) {
    return {
      BlockStatement(node) {
        checkSiblings(context, node.body);
      },
      Program(node) {
        checkSiblings(context, node.body);
      },
      SwitchCase(node) {
        checkSiblings(context, node.consequent);
      },
    };
  },
});

export { blankLineAroundMultilineStatementsRule };
