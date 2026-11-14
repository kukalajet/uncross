import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  reportMissingBlankLine,
  type StatementSibling,
} from "../shared/blank-lines.ts";

function statementList(
  parent: ESTree.ReturnStatement["parent"],
): readonly StatementSibling[] | undefined {
  switch (parent.type) {
    case "BlockStatement":
      return parent.body;
    case "SwitchCase":
      return parent.consequent;
    default:
      return undefined;
  }
}

function previousSibling(
  node: ESTree.ReturnStatement,
): StatementSibling | undefined {
  const siblings = statementList(node.parent);
  if (siblings === undefined) return undefined;

  const index = siblings.indexOf(node);
  return index > 0 ? siblings[index - 1] : undefined;
}

const blankLineBeforeReturnRule = defineRule({
  meta: {
    type: "layout",
    docs: {
      description:
        "Require a blank line before return statements that follow another statement.",
    },
    fixable: "whitespace",
    messages: {
      blankLine: "Add a blank line before this return statement.",
    },
  },
  createOnce(context) {
    return {
      ReturnStatement(node) {
        const previous = previousSibling(node);
        if (previous === undefined) return;

        reportMissingBlankLine(context, previous, node, "blankLine");
      },
    };
  },
});

export { blankLineBeforeReturnRule };
