import {
  StateEffect,
  type EditorState,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { decorateStructuralNode } from "./livePreviewStructural";
import {
  CodeLanguageWidget,
  HorizontalRuleWidget,
  MarkdownImageWidget,
  type LivePreviewImageState,
  type MarkdownImageDescriptor,
} from "./livePreviewWidgets";

export { taskToggleChange } from "./livePreviewWidgets";
export type { LivePreviewImageState } from "./livePreviewWidgets";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type VisibleRange = { from: number; to: number };
type PreviewOwner =
  | "heading"
  | "strong"
  | "emphasis"
  | "strikethrough"
  | "inline-code"
  | "link"
  | "autolink"
  | "fenced-code"
  | "image"
  | "horizontal-rule";
type HiddenSyntaxOwner = Exclude<
  PreviewOwner,
  "image" | "horizontal-rule"
>;

export interface LivePreviewConfig {
  /** 本地相对图片由宿主按项目安全边界读取；远程/data URL 由插件直接交给 img。 */
  loadImage?: (markdownPath: string) => Promise<Blob>;
}

export interface LivePreviewBuildOptions {
  state: EditorState;
  visibleRanges: readonly VisibleRange[];
  composing: boolean;
  /** compositionstart 时的文档位置；选区被 WebKit 临时挪动时仍只保护原编辑节点。 */
  compositionAnchor?: number | null;
  resolveImage?: (markdownPath: string) => LivePreviewImageState;
  /** 性能基准可注入 ensureSyntaxTree 返回的完整树；正常编辑器始终省略。 */
  tree?: ReturnType<typeof syntaxTree>;
}

export interface LivePreviewDecorationResult {
  /** 所有视觉装饰；源文档本身始终不变。 */
  decorations: DecorationSet;
  /** 只包含被隐藏的 Markdown 标记，供光标导航跳过这些零宽视觉区域。 */
  atomicRanges: DecorationSet;
}

const hiddenSyntaxByOwner: Record<HiddenSyntaxOwner, Decoration> = {
  heading: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "heading",
  }),
  strong: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "strong",
  }),
  emphasis: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "emphasis",
  }),
  strikethrough: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "strikethrough",
  }),
  "inline-code": Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "inline-code",
  }),
  link: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "link",
  }),
  autolink: Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "autolink",
  }),
  "fenced-code": Decoration.replace({
    livePreviewKind: "syntax",
    livePreviewOwner: "fenced-code",
  }),
};

const strongContent = Decoration.mark({
  class: "cm-live-strong",
  livePreviewKind: "content",
  livePreviewOwner: "strong",
});

const emphasisContent = Decoration.mark({
  class: "cm-live-emphasis",
  livePreviewKind: "content",
  livePreviewOwner: "emphasis",
});

const strikethroughContent = Decoration.mark({
  class: "cm-live-strikethrough",
  livePreviewKind: "content",
  livePreviewOwner: "strikethrough",
});

const inlineCodeContent = Decoration.mark({
  class: "cm-live-inline-code",
  livePreviewKind: "content",
  livePreviewOwner: "inline-code",
});

const headingLines = Array.from({ length: 6 }, (_, index) => {
  const level = index + 1;
  return Decoration.line({
    class: `cm-live-heading cm-live-heading-${level}`,
    livePreviewKind: "line",
    livePreviewOwner: "heading",
    livePreviewLevel: level,
  });
});

const setextUnderlineLine = Decoration.line({
  class: "cm-live-setext-underline",
  livePreviewKind: "line",
  livePreviewOwner: "heading",
});

const codeLineStart = Decoration.line({
  class: "cm-live-code-line cm-live-code-start",
  livePreviewKind: "line",
  livePreviewOwner: "fenced-code",
  livePreviewCodeLine: "start",
});

const codeLineContent = Decoration.line({
  class: "cm-live-code-line cm-live-code-content",
  livePreviewKind: "line",
  livePreviewOwner: "fenced-code",
  livePreviewCodeLine: "content",
});

const codeLineEnd = Decoration.line({
  class: "cm-live-code-line cm-live-code-end",
  livePreviewKind: "line",
  livePreviewOwner: "fenced-code",
  livePreviewCodeLine: "end",
});

/** 光标在节点边界也算命中；非空选区则按真正的区间交集判断。 */
export function selectionIntersectsNode(
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
  options: LivePreviewBuildOptions,
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

function directChildRanges(node: SyntaxNode, name: string): VisibleRange[] {
  const ranges: VisibleRange[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      ranges.push({ from: child.from, to: child.to });
    }
  }
  return ranges;
}

function directChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function hasAncestorNamed(node: SyntaxNode, names: readonly string[]): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (names.includes(current.name)) return true;
  }
  return false;
}

function headingMarkerRanges(
  state: EditorState,
  node: SyntaxNode,
): VisibleRange[] {
  const markers = directChildRanges(node, "HeaderMark");
  return markers.map((marker, index) => {
    let { from, to } = marker;
    // Lezer 的 HeaderMark 只包含 #。实时排版时顺手藏掉开头/结尾语法要求的
    // 一个分隔空格，额外空格仍保留，避免吞掉作者有意写下的缩进。
    if (from === node.from && state.sliceDoc(to, to + 1) === " ") to += 1;
    if (
      index > 0 &&
      to === node.to &&
      from - 1 > markers[index - 1].to &&
      state.sliceDoc(from - 1, from) === " "
    ) {
      from -= 1;
    }
    return { from, to };
  });
}

function addHiddenMarkers(
  owner: HiddenSyntaxOwner,
  markers: readonly VisibleRange[],
  state: EditorState,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  for (const marker of markers) {
    addHiddenRange(
      owner,
      marker.from,
      marker.to,
      state,
      visualRanges,
      atomicRanges,
    );
  }
}

/** ViewPlugin 不能提供跨换行的 replacement；按行拆开后仍能安全隐藏罕见的多行链接。 */
function addHiddenRange(
  owner: HiddenSyntaxOwner,
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

function addDelimitedNode(
  node: SyntaxNode,
  markerName: string,
  owner: HiddenSyntaxOwner,
  contentDecoration: Decoration,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const markers = directChildRanges(node, markerName);
  if (markers.length < 2) return;

  const contentFrom = markers[0].to;
  const contentTo = markers[markers.length - 1].from;
  if (contentFrom < contentTo) {
    visualRanges.push(contentDecoration.range(contentFrom, contentTo));
  }

  if (!editingIntersectsNode(options, node.from, node.to)) {
    addHiddenMarkers(
      owner,
      markers,
      options.state,
      visualRanges,
      atomicRanges,
    );
  }
}

function addLinkNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const markers = directChildRanges(node, "LinkMark");
  if (markers.length < 2) return;

  const labelFrom = markers[0].to;
  const labelTo = markers[1].from;
  const urlNode = directChild(node, "URL");
  const linkLabel = directChild(node, "LinkLabel");
  const target = urlNode
    ? options.state.sliceDoc(urlNode.from, urlNode.to)
    : linkLabel
      ? options.state.sliceDoc(linkLabel.from, linkLabel.to)
      : "";

  if (labelFrom < labelTo) {
    visualRanges.push(
      linkContentDecoration("link", target).range(labelFrom, labelTo),
    );
  }

  if (editingIntersectsNode(options, node.from, node.to)) {
    return;
  }
  addHiddenRange(
    "link",
    markers[0].from,
    markers[0].to,
    options.state,
    visualRanges,
    atomicRanges,
  );
  addHiddenRange(
    "link",
    markers[1].from,
    node.to,
    options.state,
    visualRanges,
    atomicRanges,
  );
}

function linkContentDecoration(owner: "link" | "autolink", target: string) {
  return Decoration.mark({
    class: "cm-live-link",
    attributes: target ? { title: target } : undefined,
    livePreviewKind: "content",
    livePreviewOwner: owner,
    livePreviewTarget: target,
  });
}

function addAutolinkNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const markers = directChildRanges(node, "LinkMark");
  const url = directChild(node, "URL");
  if (markers.length < 2 || !url) return;

  const target = options.state.sliceDoc(url.from, url.to);
  visualRanges.push(
    linkContentDecoration("autolink", target).range(url.from, url.to),
  );

  if (editingIntersectsNode(options, node.from, node.to)) {
    return;
  }
  addHiddenMarkers(
    "autolink",
    markers,
    options.state,
    visualRanges,
    atomicRanges,
  );
}

function addBareUrlNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
) {
  // URL 也用于普通链接、图片与引用定义的目标；这些已有各自的渲染规则。
  if (
    hasAncestorNamed(node, ["Link", "Image", "Autolink", "LinkReference"])
  ) {
    return;
  }
  const target = options.state.sliceDoc(node.from, node.to);
  visualRanges.push(
    linkContentDecoration("autolink", target).range(node.from, node.to),
  );
}

function addSetextHeadingNode(
  node: SyntaxNode,
  level: 1 | 2,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const marker = directChild(node, "HeaderMark");
  if (!marker) return;

  const firstLineNumber = options.state.doc.lineAt(node.from).number;
  const markerLine = options.state.doc.lineAt(marker.from);
  for (
    let lineNumber = firstLineNumber;
    lineNumber < markerLine.number;
    lineNumber += 1
  ) {
    visualRanges.push(
      headingLines[level - 1].range(options.state.doc.line(lineNumber).from),
    );
  }

  if (editingIntersectsNode(options, node.from, node.to)) {
    return;
  }

  // replacement 不能跨换行；隐藏并折叠完整下划线行，避免留下一个空白行。
  addHiddenRange(
    "heading",
    markerLine.from,
    markerLine.to,
    options.state,
    visualRanges,
    atomicRanges,
  );
  visualRanges.push(setextUnderlineLine.range(markerLine.from));
}

function addHorizontalRuleNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const line = options.state.doc.lineAt(node.from);
  if (editingIntersectsNode(options, line.from, line.to)) {
    return;
  }
  const range = Decoration.replace({
    widget: new HorizontalRuleWidget(),
    livePreviewKind: "horizontal-rule",
    livePreviewOwner: "horizontal-rule",
  }).range(line.from, line.to);
  visualRanges.push(range);
  atomicRanges.push(range);
}

function addFencedCodeNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
) {
  const markers = directChildRanges(node, "CodeMark");
  if (markers.length === 0) return;

  const firstLine = options.state.doc.lineAt(node.from);
  const closingMarker = markers.length > 1 ? markers[markers.length - 1] : null;
  const closingLine = closingMarker
    ? options.state.doc.lineAt(closingMarker.from)
    : null;
  const lastLineNumber = options.state.doc.lineAt(node.to).number;
  for (
    let lineNumber = firstLine.number;
    lineNumber <= lastLineNumber;
    lineNumber += 1
  ) {
    const line = options.state.doc.line(lineNumber);
    const decoration =
      lineNumber === firstLine.number
        ? codeLineStart
        : closingLine?.number === lineNumber
          ? codeLineEnd
          : codeLineContent;
    visualRanges.push(decoration.range(line.from));
  }

  if (editingIntersectsNode(options, node.from, node.to)) {
    return;
  }

  addHiddenRange(
    "fenced-code",
    firstLine.from,
    firstLine.to,
    options.state,
    visualRanges,
    atomicRanges,
  );
  if (closingLine && closingLine.number !== firstLine.number) {
    addHiddenRange(
      "fenced-code",
      closingLine.from,
      closingLine.to,
      options.state,
      visualRanges,
      atomicRanges,
    );
  }

  const info = directChild(node, "CodeInfo");
  const language = info
    ? options.state.sliceDoc(info.from, info.to).trim()
    : "";
  visualRanges.push(
    Decoration.widget({
      widget: new CodeLanguageWidget(language),
      side: -1,
      livePreviewKind: "code-language",
      livePreviewOwner: "fenced-code",
      livePreviewLanguage: language,
    }).range(firstLine.from),
  );
}

function stripLinkTitle(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "(" && last === ")")
  )
    ? value.slice(1, -1)
    : value;
}

function imageDescriptor(
  state: EditorState,
  node: SyntaxNode,
): MarkdownImageDescriptor | null {
  const markers = directChildRanges(node, "LinkMark");
  const url = directChild(node, "URL");
  if (markers.length < 2 || !url) return null;
  const title = directChild(node, "LinkTitle");
  return {
    target: state.sliceDoc(url.from, url.to),
    alt: state.sliceDoc(markers[0].to, markers[1].from),
    title: title
      ? stripLinkTitle(state.sliceDoc(title.from, title.to))
      : null,
  };
}

function addImageNode(
  node: SyntaxNode,
  options: LivePreviewBuildOptions,
  visualRanges: Range<Decoration>[],
  atomicRanges: Range<Decoration>[],
): boolean {
  if (
    editingIntersectsNode(options, node.from, node.to) ||
    options.state.doc.lineAt(node.from).number !==
      options.state.doc.lineAt(node.to).number
  ) {
    return false;
  }
  const image = imageDescriptor(options.state, node);
  if (!image) return false;
  const imageState = options.resolveImage?.(image.target) ?? {
    status: "error" as const,
    message: "当前编辑器没有配置图片读取器",
  };
  const range = Decoration.replace({
    widget: new MarkdownImageWidget(image, imageState),
    livePreviewKind: "image",
    livePreviewOwner: "image",
    livePreviewTarget: image.target,
    livePreviewAlt: image.alt,
    livePreviewTitle: image.title,
    livePreviewImageStatus: imageState.status,
  }).range(node.from, node.to);
  visualRanges.push(range);
  atomicRanges.push(range);
  return true;
}

export function imageMimeType(markdownPath: string): string {
  const withoutSuffix = markdownPath
    .split(/[?#]/, 1)[0]
    .replace(/^<|>$/g, "");
  let decoded = withoutSuffix;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    // 无效 percent encoding 会在 Rust 路径守卫中给出明确错误；这里只做 MIME 猜测。
  }
  const extension = decoded.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "ico":
      return "image/x-icon";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * 一次遍历当前可见语法树，构造全部实时排版装饰。
 * 这是纯函数入口，方便对选区、IME 和源码不变性做无 DOM 单测。
 */
export function buildLivePreviewDecorations(
  options: LivePreviewBuildOptions,
): LivePreviewDecorationResult {
  const visualRanges: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const seenNodes = new Set<string>();
  const tree = options.tree ?? syntaxTree(options.state);

  for (const visibleRange of options.visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(nodeRef) {
        const node = nodeRef.node;
        const nodeKey = `${node.name}:${node.from}:${node.to}`;
        if (seenNodes.has(nodeKey)) return;
        seenNodes.add(nodeKey);

        const headingMatch = /^ATXHeading([1-6])$/.exec(node.name);
        if (headingMatch) {
          const level = Number(headingMatch[1]);
          const lineFrom = options.state.doc.lineAt(node.from).from;
          visualRanges.push(headingLines[level - 1].range(lineFrom));

          if (!editingIntersectsNode(options, node.from, node.to)) {
            addHiddenMarkers(
              "heading",
              headingMarkerRanges(options.state, node),
              options.state,
              visualRanges,
              atomicRanges,
            );
          }
          return;
        }

        const setextHeadingMatch = /^SetextHeading([12])$/.exec(node.name);
        if (setextHeadingMatch) {
          addSetextHeadingNode(
            node,
            Number(setextHeadingMatch[1]) as 1 | 2,
            options,
            visualRanges,
            atomicRanges,
          );
          return;
        }

        if (
          decorateStructuralNode(
            node,
            options,
            visualRanges,
            atomicRanges,
          )
        ) {
          return;
        }

        switch (node.name) {
          case "StrongEmphasis":
            addDelimitedNode(
              node,
              "EmphasisMark",
              "strong",
              strongContent,
              options,
              visualRanges,
              atomicRanges,
            );
            break;
          case "Emphasis":
            addDelimitedNode(
              node,
              "EmphasisMark",
              "emphasis",
              emphasisContent,
              options,
              visualRanges,
              atomicRanges,
            );
            break;
          case "Strikethrough":
            addDelimitedNode(
              node,
              "StrikethroughMark",
              "strikethrough",
              strikethroughContent,
              options,
              visualRanges,
              atomicRanges,
            );
            break;
          case "InlineCode":
            addDelimitedNode(
              node,
              "CodeMark",
              "inline-code",
              inlineCodeContent,
              options,
              visualRanges,
              atomicRanges,
            );
            break;
          case "Link":
            addLinkNode(node, options, visualRanges, atomicRanges);
            break;
          case "Autolink":
            addAutolinkNode(node, options, visualRanges, atomicRanges);
            return false;
          case "URL":
            addBareUrlNode(node, options, visualRanges);
            break;
          case "FencedCode":
            addFencedCodeNode(node, options, visualRanges, atomicRanges);
            break;
          case "Image":
            if (addImageNode(node, options, visualRanges, atomicRanges)) {
              return false;
            }
            break;
          case "HorizontalRule":
            addHorizontalRuleNode(
              node,
              options,
              visualRanges,
              atomicRanges,
            );
            break;
        }
      },
    });
  }

  return {
    decorations: Decoration.set(visualRanges, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
}

const setCompositionActive = StateEffect.define<boolean>();
const imagePreviewChanged = StateEffect.define<string>();
const MAX_IMAGE_CACHE_ENTRIES = 64;

function directImageState(target: string): LivePreviewImageState | null {
  const trimmed = target.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return { status: "ready", src: trimmed };
  }
  if (trimmed.startsWith("//")) {
    return { status: "ready", src: `https:${trimmed}` };
  }
  if (trimmed.startsWith("/")) {
    return {
      status: "error",
      message: "站点根路径图片请在真实网页预览中查看",
    };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return { status: "error", message: "不支持该图片 URL 协议" };
  }
  return null;
}

function previewErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

class LivePreviewPluginValue {
  decorations: DecorationSet = Decoration.none;
  atomicRanges: DecorationSet = Decoration.none;
  private composing: boolean;
  private compositionAnchor: number | null;
  private destroyed = false;
  private syntaxTree: ReturnType<typeof syntaxTree>;
  private readonly imageCache = new Map<string, LivePreviewImageState>();
  private readonly objectUrls = new Set<string>();

  constructor(
    view: EditorView,
    private readonly config: LivePreviewConfig,
  ) {
    this.composing = view.compositionStarted;
    this.compositionAnchor = this.composing
      ? view.state.selection.main.head
      : null;
    this.syntaxTree = syntaxTree(view.state);
    this.rebuild(view);
  }

  update(update: ViewUpdate) {
    let compositionChanged = false;
    let imageChanged = false;
    for (const transaction of update.transactions) {
      if (this.compositionAnchor !== null && transaction.docChanged) {
        this.compositionAnchor = transaction.changes.mapPos(
          this.compositionAnchor,
          1,
        );
      }
      for (const effect of transaction.effects) {
        if (effect.is(setCompositionActive)) {
          if (effect.value) {
            this.compositionAnchor = transaction.state.selection.main.head;
          } else {
            this.compositionAnchor = null;
          }
          if (effect.value !== this.composing) {
            this.composing = effect.value;
            compositionChanged = true;
          }
        }
        if (effect.is(imagePreviewChanged)) imageChanged = true;
      }
    }
    // Lezer 会在文档不变时通过内部 effect 推进后台解析；只看 docChanged 会让
    // 长文档中刚解析完成的区域一直维持旧装饰，直到用户再动一次光标。
    const nextSyntaxTree = syntaxTree(update.state);
    const syntaxTreeChanged = nextSyntaxTree !== this.syntaxTree;
    this.syntaxTree = nextSyntaxTree;

    if (
      compositionChanged ||
      imageChanged ||
      syntaxTreeChanged ||
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged
    ) {
      this.rebuild(update.view);
    }
  }

  private rebuild(view: EditorView) {
    const result = buildLivePreviewDecorations({
      state: view.state,
      visibleRanges: view.visibleRanges,
      composing: this.composing,
      compositionAnchor: this.compositionAnchor,
      resolveImage: (markdownPath) => this.resolveImage(markdownPath, view),
    });
    this.decorations = result.decorations;
    this.atomicRanges = result.atomicRanges;
  }

  private resolveImage(
    markdownPath: string,
    view: EditorView,
  ): LivePreviewImageState {
    const direct = directImageState(markdownPath);
    if (direct) return direct;

    const cached = this.imageCache.get(markdownPath);
    if (cached) {
      // Map 的插入顺序充当轻量 LRU；命中后移到末尾。
      this.imageCache.delete(markdownPath);
      this.imageCache.set(markdownPath, cached);
      return cached;
    }
    if (!this.config.loadImage) {
      return { status: "error", message: "当前编辑器没有配置图片读取器" };
    }

    const loading = { status: "loading" } as const;
    this.cacheImage(markdownPath, loading);
    void Promise.resolve()
      .then(() => this.config.loadImage!(markdownPath))
      .then((blob) => {
        if (this.destroyed) return;
        const src = URL.createObjectURL(blob);
        this.objectUrls.add(src);
        this.cacheImage(markdownPath, { status: "ready", src });
        view.dispatch({ effects: imagePreviewChanged.of(markdownPath) });
      })
      .catch((error: unknown) => {
        if (this.destroyed) return;
        this.cacheImage(markdownPath, {
          status: "error",
          message: previewErrorMessage(error),
        });
        view.dispatch({ effects: imagePreviewChanged.of(markdownPath) });
      });
    return loading;
  }

  private cacheImage(markdownPath: string, state: LivePreviewImageState) {
    const previous = this.imageCache.get(markdownPath);
    if (
      previous?.status === "ready" &&
      (state.status !== "ready" || previous.src !== state.src)
    ) {
      this.revokeObjectUrl(previous.src);
    }
    this.imageCache.delete(markdownPath);
    this.imageCache.set(markdownPath, state);

    while (this.imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
      const oldestPath = this.imageCache.keys().next().value as
        | string
        | undefined;
      if (oldestPath === undefined) break;
      const oldest = this.imageCache.get(oldestPath);
      this.imageCache.delete(oldestPath);
      if (oldest?.status === "ready") this.revokeObjectUrl(oldest.src);
    }
  }

  private revokeObjectUrl(url: string) {
    if (!this.objectUrls.delete(url)) return;
    URL.revokeObjectURL(url);
  }

  destroy() {
    this.destroyed = true;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.imageCache.clear();
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(
  LivePreviewPluginValue,
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none,
      ),
    eventObservers: {
      compositionstart(_event, view) {
        view.dispatch({ effects: setCompositionActive.of(true) });
      },
      compositionend(_event, view) {
        // WebKit/部分 Linux 输入法会在 compositionend 后才提交最后一批 DOM mutation。
        // 延迟到下一帧，并确认没有开启新的 composition，再恢复 replacement 装饰。
        const releaseComposition = () => {
          if (!view.compositionStarted && view.dom.isConnected) {
            view.dispatch({ effects: setCompositionActive.of(false) });
          }
        };
        const ownerWindow = view.dom.ownerDocument.defaultView;
        if (ownerWindow) ownerWindow.requestAnimationFrame(releaseComposition);
        else queueMicrotask(releaseComposition);
      },
    },
  },
);

export function createLivePreviewExtension(
  config: LivePreviewConfig = {},
) {
  return livePreviewPlugin.of(config);
}

/** 无本地图片读取能力的默认实例，主要用于纯编辑器嵌入与状态测试。 */
export const livePreviewExtension = createLivePreviewExtension();
