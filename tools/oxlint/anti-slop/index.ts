import { eslintCompatPlugin } from "@oxlint/plugins";

import { blankLineAroundBlocksRule } from "./rules/blank-line-around-blocks.ts";
import { blankLineAroundMultilineStatementsRule } from "./rules/blank-line-around-multiline-statements.ts";
import { blankLineBeforeReturnRule } from "./rules/blank-line-before-return.ts";
import { importOrderRule } from "./rules/import-order.ts";
import { maxLoopSkipsRule } from "./rules/max-loop-skips.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noInlineExportsRule } from "./rules/no-inline-exports.ts";
import { noInlineRegexMatchRule } from "./rules/no-inline-regex-match.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "blank-line-around-blocks": blankLineAroundBlocksRule,
    "blank-line-around-multiline-statements":
      blankLineAroundMultilineStatementsRule,
    "blank-line-before-return": blankLineBeforeReturnRule,
    "import-order": importOrderRule,
    "max-loop-skips": maxLoopSkipsRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-inline-exports": noInlineExportsRule,
    "no-inline-regex-match": noInlineRegexMatchRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-safety-comment-for-type-assertion":
      requireSafetyCommentForTypeAssertionRule,
  },
});
