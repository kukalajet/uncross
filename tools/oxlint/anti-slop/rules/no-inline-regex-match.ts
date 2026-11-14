import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const regexReceiverMethods = new Set(["test", "exec"]);
const regexArgumentMethods = new Set(["match", "matchAll", "search"]);

function isRegExpLiteral(
  node: ESTree.Node | undefined,
): node is ESTree.RegExpLiteral {
  return node?.type === "Literal" && "regex" in node;
}

function inlineRegex(
  node: ESTree.CallExpression,
): ESTree.RegExpLiteral | undefined {
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" || callee.computed ||
    callee.property.type !== "Identifier"
  ) {
    return undefined;
  }

  const method = callee.property.name;
  if (regexReceiverMethods.has(method) && isRegExpLiteral(callee.object)) {
    // `const isSqlState = /.../.test(code)` names the rule through its result.
    const namesResult = method === "test" &&
      node.parent.type === "VariableDeclarator";

    return namesResult ? undefined : callee.object;
  }

  const [firstArgument] = node.arguments;
  if (regexArgumentMethods.has(method) && isRegExpLiteral(firstArgument)) {
    return firstArgument;
  }

  return undefined;
}

const noInlineRegexMatchRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require regular expressions used for matching to have a name that says what they match.",
    },
    messages: {
      inlineRegex:
        "Assign this regular expression to a named const that says what it matches (READABILITY.md, rule 1).",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const regex = inlineRegex(node);
        if (regex !== undefined) {
          context.report({ node: regex, messageId: "inlineRegex" });
        }
      },
    };
  },
});

export { noInlineRegexMatchRule };
