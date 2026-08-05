import type { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { ListMarkerWidget, TaskCheckboxWidget } from "./livePreviewWidgets";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type StructuralOwner = "blockquote" | "list" | "task" | "table";

export interface StructuralPreviewOptions {
  state: EditorState;
  composing: boolean;
  compositionAnchor?: number | null;
}

const hiddenSyntaxByOwner: Record<StructuralOwner, Decoration> = {
  blockquote: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "blockquote",
  }),
  list: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "list",
  }),
  task: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "task",
  }),
  table: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "table",
  }),
};

const quoteLine = Decoration.line({
  class: "cm-live-quote-line",
  livePreviewKind: "line",
  livePreviewOwner: "blockquote",
});

const listLine = Decoration.line({
  class: "cm-live-list-line",
  livePreviewKind: "line",
  livePreviewOwner: "list",
});

const tableHeaderLine = Decoration.line({
  class: "cm-live-table-line cm-live-table-header",
  livePreviewKind: "line",
  livePreviewOwner: "table",
  livePreviewTableLine: "header",
});

const tableSeparatorLine = Decoration.line({
  class: "cm-live-table-line cm-live-table-separator",
  livePreviewKind: "line",
  livePreviewOwner: "table",
  livePreviewTableLine: "separator",
});

const tableRowLine = Decoration.line({
  class: "cm-live-table-line cm-live-table-row",
  livePreviewKind: "line",
  livePreviewOwner: "table",
  livePreviewTableLine: "row",
});

const tableEndLine = Decoration.line({
  class: "cm-live-table-line cm-live-table-row cm-live-table-end",
  livePreviewKind: "line",
  livePreviewOwner: "table",
  livePreviewTableLine: "end",
});

const tableCell = Decoration.mark({
  class: "cm-live-table-cell",
  livePreviewKind: "content",
  livePreviewOwner: "table",
});

const tableHeaderCell = Decoration.mark({
  class: "cm-live-table-cell cm-live-table-header-cell",
  livePreviewKind: "content",
  livePreviewOwner: "table",
});

function selectionIntersectsNode(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from,
  );
}

function editingIntersectsNode(
  options: StructuralPreviewOptions,
  from: number,
  to: number,
): boolean {
  if (selectionIntersectsNode(options.state, from, to)) return true;
  const anchor = options.compositionAnchor;
  return (
    options.composing &&
    anchor !== null &&
    anchor !== undefined &&
    anchor >= from &&
    anchor <= to
  );
}

function directChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function ancestorNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.name === name) return current;
  }
  return null;
}

function addLineDecorations(
  state: EditorState,
  from: number,
  to: number,
  decoration: Decoration,
  visualRanges: Range<Decoration>[],
) {
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(to).number;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    visualRanges.push(decoration.range(state.doc.line(lineNumber).from));
  }
}

function addHiddenRange(
  owner: StructuralOwner,
  from: number,
  to: number,
  state: EditorState,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  let cursor = from;
  while (cursor < to) {
    const line = state.doc.lineAt(cursor);
    const rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) {
      const range = hiddenSyntaxByOwner[owner].range(cursor, rangeTo);
      visualRanges.push(range);
      atomicRanges.push(range);
    }
    if (line.to >= to) break;
    cursor = line.to + 1;
  }
}

function addBlockquoteNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
) {
  addLineDecorations(
    options.state,
    node.from,
    node.to,
    quoteLine,
    visualRanges,
  );
}

function addQuoteMarkNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const blockquote = ancestorNamed(node, "Blockquote");
  if (
    !blockquote ||
    editingIntersectsNode(options, blockquote.from, blockquote.to)
  ) {
    return;
  }
  const to = /[ \t]/.test(options.state.sliceDoc(node.to, node.to + 1))
    ? node.to + 1
    : node.to;
  addHiddenRange(
    "blockquote",
    node.from,
    to,
    options.state,
    visualRanges,
    atomicRanges,
  );
}

function addListItemNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  addLineDecorations(options.state, node.from, node.to, listLine, visualRanges);
  const marker = directChild(node, "ListMark");
  if (!marker || editingIntersectsNode(options, node.from, node.to)) {
    return;
  }

  const markerTo = /[ \t]/.test(
    options.state.sliceDoc(marker.to, marker.to + 1),
  )
    ? marker.to + 1
    : marker.to;
  if (directChild(node, "Task")) {
    addHiddenRange(
      "list",
      marker.from,
      markerTo,
      options.state,
      visualRanges,
      atomicRanges,
    );
    return;
  }

  const ordered = node.parent?.name === "OrderedList";
  const label = ordered ? options.state.sliceDoc(marker.from, marker.to) : "•";
  const range = Decoration.replace({
    widget: new ListMarkerWidget(label, ordered),
    livePreviewKind: "list-marker",
    livePreviewOwner: "list",
    livePreviewListKind: ordered ? "ordered" : "bullet",
    livePreviewMarker: label,
  }).range(marker.from, markerTo);
  visualRanges.push(range);
  atomicRanges.push(range);
}

function addTaskNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const marker = directChild(node, "TaskMarker");
  const listItem = ancestorNamed(node, "ListItem");
  if (!marker || !listItem) return;

  const checked = /[xX]/.test(options.state.sliceDoc(marker.from, marker.to));
  const contentFrom = /[ \t]/.test(
    options.state.sliceDoc(marker.to, marker.to + 1),
  )
    ? marker.to + 1
    : marker.to;
  if (contentFrom < node.to) {
    visualRanges.push(
      Decoration.mark({
        class: checked
          ? "cm-live-task-text cm-live-task-complete"
          : "cm-live-task-text",
        livePreviewKind: "content",
        livePreviewOwner: "task",
        livePreviewTaskChecked: checked,
      }).range(contentFrom, node.to),
    );
  }

  if (editingIntersectsNode(options, listItem.from, listItem.to)) {
    return;
  }
  const range = Decoration.replace({
    widget: new TaskCheckboxWidget(marker.from, checked),
    livePreviewKind: "task-checkbox",
    livePreviewOwner: "task",
    livePreviewTaskChecked: checked,
  }).range(marker.from, contentFrom);
  visualRanges.push(range);
  atomicRanges.push(range);
}

function addTableLineNode(
  node: SyntaxNode,
  decoration: Decoration,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
) {
  visualRanges.push(decoration.range(options.state.doc.lineAt(node.from).from));
}

function addTableDelimiterNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const table = ancestorNamed(node, "Table");
  if (!table) return;
  if (node.parent?.name === "Table") {
    addTableLineNode(node, tableSeparatorLine, options, visualRanges);
  }
  if (editingIntersectsNode(options, table.from, table.to)) {
    return;
  }
  addHiddenRange(
    "table",
    node.from,
    node.to,
    options.state,
    visualRanges,
    atomicRanges,
  );
}

function addTableCellNode(node: SyntaxNode, visualRanges: Range<Decoration>[]) {
  const inHeader = ancestorNamed(node, "TableHeader") !== null;
  visualRanges.push(
    (inHeader ? tableHeaderCell : tableCell).range(node.from, node.to),
  );
}

/** 返回 true 表示该节点属于结构化块规则，调用方无需再走其它分发。 */
export function decorateStructuralNode(
  node: SyntaxNode,
  options: StructuralPreviewOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
): boolean {
  switch (node.name) {
    case "Blockquote":
      addBlockquoteNode(node, options, visualRanges);
      return true;
    case "QuoteMark":
      addQuoteMarkNode(node, options, visualRanges, atomicRanges);
      return true;
    case "ListItem":
      addListItemNode(node, options, visualRanges, atomicRanges);
      return true;
    case "Task":
      addTaskNode(node, options, visualRanges, atomicRanges);
      return true;
    case "TableHeader":
      addTableLineNode(node, tableHeaderLine, options, visualRanges);
      return true;
    case "TableRow":
      addTableLineNode(
        node,
        node.nextSibling ? tableRowLine : tableEndLine,
        options,
        visualRanges,
      );
      return true;
    case "TableDelimiter":
      addTableDelimiterNode(node, options, visualRanges, atomicRanges);
      return true;
    case "TableCell":
      addTableCellNode(node, visualRanges);
      return true;
    default:
      return false;
  }
}
