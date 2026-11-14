import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const maxSkipGuardsPerLoop = 2;
const loopTypes = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// Keyed by loop node, so counts never carry over between files.
const skipGuardCounts = new WeakMap<ESTree.Node, number>();

// `if (condition) continue;` skips the item. A `continue` that ends a larger
// branch is control flow, not a skip guard.
function isSkipGuard(node: ESTree.ContinueStatement): boolean {
  const parent = node.parent;
  if (parent.type === "IfStatement") return parent.consequent === node;

  return parent.type === "BlockStatement" && parent.body.length === 1 &&
    parent.parent.type === "IfStatement" && parent.parent.consequent === parent;
}

function enclosingLoop(
  node: ESTree.ContinueStatement,
): ESTree.Node | undefined {
  let current: ESTree.Node | null = node.parent;
  while (current !== null) {
    if (loopTypes.has(current.type)) return current;
    if (functionTypes.has(current.type)) return undefined;
    current = current.parent;
  }

  return undefined;
}

const maxLoopSkipsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Limit how many `if (...) continue;` guards one loop body may use to skip items.",
    },
    messages: {
      tooManySkips:
        "This loop skips items with more than two `if (...) continue;` guards. Move the per-item checks into a function that returns whether or what to keep (READABILITY.md, rule 3).",
    },
  },
  createOnce(context) {
    return {
      ContinueStatement(node) {
        if (!isSkipGuard(node)) return;

        const loop = enclosingLoop(node);
        if (loop === undefined) return;

        const count = (skipGuardCounts.get(loop) ?? 0) + 1;
        skipGuardCounts.set(loop, count);
        if (count === maxSkipGuardsPerLoop + 1) {
          context.report({ node: loop, messageId: "tooManySkips" });
        }
      },
    };
  },
});

export { maxLoopSkipsRule };
