import type { Comment, Context, ESTree, SourceCode } from "@oxlint/plugins";

type StatementSibling = ESTree.Directive | ESTree.Statement;

const blockTypes = new Set([
  "BlockStatement",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "LabeledStatement",
  "SwitchStatement",
  "TryStatement",
  "WhileStatement",
]);
const exitTypes = new Set([
  "BreakStatement",
  "ContinueStatement",
  "ReturnStatement",
  "ThrowStatement",
]);

// A guard belongs with the statement that produced the value it checks, so it
// is not separated from its neighbours.
function isGuard(node: StatementSibling): boolean {
  if (node.type !== "IfStatement" || node.alternate !== null) return false;

  // A block with more than one statement stays a BlockStatement here, which
  // is not an exit.
  const body = node.consequent.type === "BlockStatement" &&
      node.consequent.body.length === 1
    ? node.consequent.body[0]
    : node.consequent;

  return body !== undefined && exitTypes.has(body.type);
}

function isSeparatedBlock(node: StatementSibling): boolean {
  return blockTypes.has(node.type) &&
    node.loc.end.line > node.loc.start.line && !isGuard(node);
}

function commentsBetween(
  sourceCode: SourceCode,
  previous: StatementSibling,
  node: StatementSibling,
): Comment[] {
  return sourceCode.getAllComments().filter((comment) =>
    comment.end > previous.end && comment.start < node.start
  );
}

function hasRealEmptyLine(
  sourceCode: SourceCode,
  previous: StatementSibling,
  node: StatementSibling,
  comments: ReadonlyArray<Comment>,
): boolean {
  for (
    let line = previous.loc.end.line + 1;
    line < node.loc.start.line;
    line += 1
  ) {
    const isCommentLine = comments.some((comment) =>
      comment.loc.start.line <= line && comment.loc.end.line >= line
    );
    if (!isCommentLine && sourceCode.lines[line - 1]?.trim() === "") {
      return true;
    }
  }

  return false;
}

function ownLineStart(
  sourceCode: SourceCode,
  start: number,
  line: number,
): number | undefined {
  const lineStart = sourceCode.lineStartIndices[line - 1];
  return lineStart !== undefined &&
      /^[\t ]*$/.test(sourceCode.text.slice(lineStart, start))
    ? lineStart
    : undefined;
}

// Reports `node` unless an empty line separates it from `previous`. The fix
// inserts the line above any comments that lead into `node`, and is skipped
// when `node` or its comment shares a line with other code.
function reportMissingBlankLine(
  context: Context,
  previous: StatementSibling,
  node: StatementSibling,
  messageId: string,
): void {
  const comments = commentsBetween(context.sourceCode, previous, node);
  if (hasRealEmptyLine(context.sourceCode, previous, node, comments)) return;

  const nodeLineStart = ownLineStart(
    context.sourceCode,
    node.start,
    node.loc.start.line,
  );
  if (nodeLineStart === undefined) {
    context.report({ node, messageId });
    return;
  }

  const leadingComment = comments.find((comment) =>
    comment.loc.start.line > previous.loc.end.line
  );
  const insertionLineStart = leadingComment === undefined
    ? nodeLineStart
    : ownLineStart(
      context.sourceCode,
      leadingComment.start,
      leadingComment.loc.start.line,
    );
  if (insertionLineStart === undefined) {
    context.report({ node, messageId });
    return;
  }

  const newline = context.sourceCode.text.includes("\r\n") ? "\r\n" : "\n";
  context.report({
    node,
    messageId,
    fix(fixer) {
      return fixer.insertTextBeforeRange(
        [insertionLineStart, insertionLineStart],
        newline,
      );
    },
  });
}

export { blockTypes, isGuard, isSeparatedBlock, reportMissingBlankLine };
export type { StatementSibling };
