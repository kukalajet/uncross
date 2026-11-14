import { defineRule } from "@oxlint/plugins";
import type { Context } from "@oxlint/plugins";

import {
  isSeparatedBlock,
  reportMissingBlankLine,
  type StatementSibling,
} from "../shared/blank-lines.ts";

function checkSiblings(
  context: Context,
  siblings: ReadonlyArray<StatementSibling>,
): void {
  siblings.forEach((node, index) => {
    const previous = siblings[index - 1];
    // blank-line-before-return already owns the gap before a return.
    if (previous === undefined || node.type === "ReturnStatement") return;

    if (isSeparatedBlock(previous) || isSeparatedBlock(node)) {
      reportMissingBlankLine(context, previous, node, "blankLine");
    }
  });
}

const blankLineAroundBlocksRule = defineRule({
  meta: {
    type: "layout",
    docs: {
      description:
        "Require blank lines around multi-line block statements, except guard clauses.",
    },
    fixable: "whitespace",
    messages: {
      blankLine: "Separate this multi-line block with a blank line.",
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

export { blankLineAroundBlocksRule };
