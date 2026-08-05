import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildLivePreviewDecorations,
  imageMimeType,
  type LivePreviewImageState,
  livePreviewExtension,
  selectionIntersectsNode,
  taskToggleChange,
} from "./livePreview";

interface DecorationSnapshot {
  from: number;
  to: number;
  text: string;
  kind?: string;
  owner?: string;
  className?: string;
  level?: number;
  target?: string;
  alt?: string;
  title?: string | null;
  imageStatus?: string;
  language?: string;
  codeLine?: string;
  listKind?: string;
  marker?: string;
  checked?: boolean;
  tableLine?: string;
}

function createState(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function snapshots(
  decorations: DecorationSet,
  state: EditorState,
): DecorationSnapshot[] {
  const result: DecorationSnapshot[] = [];
  for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
    result.push({
      from: cursor.from,
      to: cursor.to,
      text: state.sliceDoc(cursor.from, cursor.to),
      kind: cursor.value.spec.livePreviewKind,
      owner: cursor.value.spec.livePreviewOwner,
      className: cursor.value.spec.class,
      level: cursor.value.spec.livePreviewLevel,
      target: cursor.value.spec.livePreviewTarget,
      alt: cursor.value.spec.livePreviewAlt,
      title: cursor.value.spec.livePreviewTitle,
      imageStatus: cursor.value.spec.livePreviewImageStatus,
      language: cursor.value.spec.livePreviewLanguage,
      codeLine: cursor.value.spec.livePreviewCodeLine,
      listKind: cursor.value.spec.livePreviewListKind,
      marker: cursor.value.spec.livePreviewMarker,
      checked: cursor.value.spec.livePreviewTaskChecked,
      tableLine: cursor.value.spec.livePreviewTableLine,
    });
  }
  return result;
}

function build(
  state: EditorState,
  composing = false,
  visibleRanges = [{ from: 0, to: state.doc.length }],
  resolveImage?: (markdownPath: string) => LivePreviewImageState,
  compositionAnchor: number | null = null,
) {
  return buildLivePreviewDecorations({
    state,
    composing,
    compositionAnchor,
    visibleRanges,
    resolveImage,
  });
}

describe("live preview decorations", () => {
  it("styles the first supported nodes and hides their Markdown markers", () => {
    const doc = "# 标题\n\n普通 **粗体**、*斜体* 和 `代码`。\n\n光标在这里";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const hidden = visual.filter((item) => item.kind === "syntax");
    const content = visual.filter((item) => item.kind === "content");

    expect(hidden.map(({ owner, text }) => `${owner}:${text}`)).toEqual([
      "heading:# ",
      "strong:**",
      "strong:**",
      "emphasis:*",
      "emphasis:*",
      "inline-code:`",
      "inline-code:`",
    ]);
    expect(content.map(({ owner, text }) => `${owner}:${text}`)).toEqual([
      "strong:粗体",
      "emphasis:斜体",
      "inline-code:代码",
    ]);
    expect(visual).toContainEqual(
      expect.objectContaining({
        kind: "line",
        level: 1,
        className: "cm-live-heading cm-live-heading-1",
      }),
    );

    const atomic = snapshots(result.atomicRanges, state);
    expect(atomic).toEqual(hidden);
    expect(state.doc.toString()).toBe(doc);
  });

  it("reveals a node's source markers when the cursor or selection enters it", () => {
    const doc = "前 **粗体** 后 *斜体* 尾";
    const strongCursor = doc.indexOf("粗体") + 1;
    const strongState = createState(doc, strongCursor);
    const strongHidden = snapshots(
      build(strongState).decorations,
      strongState,
    ).filter((item) => item.kind === "syntax");

    expect(strongHidden.some((item) => item.owner === "strong")).toBe(false);
    expect(
      strongHidden.filter((item) => item.owner === "emphasis"),
    ).toHaveLength(2);

    const emphasisFrom = doc.indexOf("斜体");
    const emphasisState = createState(doc, emphasisFrom, emphasisFrom + 2);
    const emphasisHidden = snapshots(
      build(emphasisState).decorations,
      emphasisState,
    ).filter((item) => item.kind === "syntax");

    expect(emphasisHidden.some((item) => item.owner === "emphasis")).toBe(
      false,
    );
  });

  it("keeps nodes outside the IME composition anchor rendered", () => {
    const doc = "**粗体**、*斜体*、`代码`，光标";
    const state = createState(doc, doc.length);
    const result = build(state, true);
    const visual = snapshots(result.decorations, state);

    expect(visual.filter((item) => item.kind === "syntax")).toHaveLength(6);
    expect(snapshots(result.atomicRanges, state)).toHaveLength(6);
    expect(visual.filter((item) => item.kind === "content")).toHaveLength(3);
  });

  it("reveals only the node captured when IME composition started", () => {
    const doc = "**粗体**、*斜体*，选区后来移动到这里";
    const state = createState(doc, doc.length);
    const visual = snapshots(
      build(
        state,
        true,
        [{ from: 0, to: state.doc.length }],
        undefined,
        doc.indexOf("粗体") + 1,
      ).decorations,
      state,
    );

    expect(
      visual.some((item) => item.kind === "syntax" && item.owner === "strong"),
    ).toBe(false);
    expect(
      visual.filter(
        (item) => item.kind === "syntax" && item.owner === "emphasis",
      ),
    ).toHaveLength(2);
  });

  it("only decorates syntax nodes intersecting visible ranges", () => {
    const doc = "# 不可见\n\n中间文字\n\n**可见**\n\n末尾光标";
    const visibleFrom = doc.indexOf("**可见**");
    const state = createState(doc, doc.length);
    const visual = snapshots(
      build(state, false, [{ from: visibleFrom, to: doc.length }]).decorations,
      state,
    );

    expect(visual.some((item) => item.owner === "heading")).toBe(false);
    expect(visual.filter((item) => item.owner === "strong")).not.toEqual([]);
  });

  it("handles nested emphasis without producing invalid ranges", () => {
    const doc = "***嵌套***，光标";
    const state = createState(doc, doc.length);

    expect(() => build(state)).not.toThrow();
    const owners = snapshots(build(state).decorations, state)
      .filter((item) => item.kind === "content")
      .map((item) => item.owner);
    expect(owners).toEqual(expect.arrayContaining(["strong", "emphasis"]));
  });

  it("renders strikethrough while preserving nested inline formatting", () => {
    const doc = "旧 ~~删除 **内容**~~ 新，光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const strikeSyntax = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "strikethrough",
    );

    expect(strikeSyntax.map((item) => item.text)).toEqual(["~~", "~~"]);
    expect(visual).toContainEqual(
      expect.objectContaining({
        kind: "content",
        owner: "strikethrough",
        text: "删除 **内容**",
        className: "cm-live-strikethrough",
      }),
    );
    expect(visual).toContainEqual(
      expect.objectContaining({
        kind: "content",
        owner: "strong",
        text: "内容",
      }),
    );
    expect(snapshots(result.atomicRanges, state)).toEqual(
      expect.arrayContaining(strikeSyntax),
    );

    const activeState = createState(doc, doc.indexOf("删除") + 1);
    expect(
      snapshots(build(activeState).decorations, activeState).some(
        (item) => item.kind === "syntax" && item.owner === "strikethrough",
      ),
    ).toBe(false);
    expect(state.doc.toString()).toBe(doc);
  });

  it("handles empty and closing-marker headings without overlapping ranges", () => {
    const doc = "# #\n\n光标";
    const state = createState(doc, doc.length);
    const hidden = snapshots(build(state).decorations, state).filter(
      (item) => item.kind === "syntax",
    );

    expect(hidden.map((item) => item.text)).toEqual(["# ", "#"]);
    expect(hidden[0].to).toBeLessThanOrEqual(hidden[1].from);
  });

  it("can be reconfigured without changing the document or clearing undo", () => {
    const mode = new Compartment();
    let state = EditorState.create({
      doc: "**原文**",
      extensions: [history(), mode.of(livePreviewExtension)],
    });
    state = state.update({
      changes: { from: state.doc.length, insert: "!" },
    }).state;
    state = state.update({ effects: mode.reconfigure([]) }).state;

    const didUndo = undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    });

    expect(didUndo).toBe(true);
    expect(state.doc.toString()).toBe("**原文**");
  });

  it("renders inline and reference links as styled labels", () => {
    const doc =
      '访问 [示例 **站点**](https://example.com "标题") 和 [参考][id]。\n\n[id]: /docs\n\n光标';
    const state = createState(doc, doc.length);
    const visual = snapshots(build(state).decorations, state);
    const linkSyntax = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "link",
    );
    const links = visual.filter(
      (item) => item.kind === "content" && item.owner === "link",
    );

    expect(linkSyntax.map((item) => item.text)).toEqual([
      "[",
      '](https://example.com "标题")',
      "[",
      "][id]",
    ]);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "示例 **站点**",
          target: "https://example.com",
        }),
        expect.objectContaining({ text: "参考", target: "[id]" }),
      ]),
    );
  });

  it("reveals the complete link source when the cursor enters its node", () => {
    const doc = "前 [链接](https://example.com) 后";
    const cursor = doc.indexOf("链接") + 1;
    const state = createState(doc, cursor);
    const visual = snapshots(build(state).decorations, state);

    expect(
      visual.some((item) => item.kind === "syntax" && item.owner === "link"),
    ).toBe(false);
    expect(
      visual.some((item) => item.kind === "content" && item.owner === "link"),
    ).toBe(true);
  });

  it("styles angle and bare autolinks without decorating reference targets", () => {
    const doc =
      "访问 <https://example.com/docs> www.example.com user@example.com\n\n[id]: https://definition.example\n\n光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const autolinks = visual.filter(
      (item) => item.kind === "content" && item.owner === "autolink",
    );
    const syntax = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "autolink",
    );

    expect(autolinks.map((item) => [item.text, item.target])).toEqual([
      ["https://example.com/docs", "https://example.com/docs"],
      ["www.example.com", "www.example.com"],
      ["user@example.com", "user@example.com"],
    ]);
    expect(syntax.map((item) => item.text)).toEqual(["<", ">"]);
    expect(
      autolinks.some((item) => item.text === "https://definition.example"),
    ).toBe(false);
    expect(snapshots(result.atomicRanges, state)).toEqual(
      expect.arrayContaining(syntax),
    );

    const activeState = createState(
      doc,
      doc.indexOf("https://example.com/docs") + 3,
    );
    const activeVisual = snapshots(build(activeState).decorations, activeState);
    expect(
      activeVisual.some(
        (item) => item.kind === "syntax" && item.owner === "autolink",
      ),
    ).toBe(false);
    expect(
      activeVisual.some(
        (item) => item.kind === "content" && item.owner === "autolink",
      ),
    ).toBe(true);
  });

  it("renders Setext headings and collapses only their underline lines", () => {
    const doc = "一级标题\n===\n\n二级 **标题**\n---\n\n光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const headingLines = visual.filter(
      (item) =>
        item.kind === "line" &&
        item.owner === "heading" &&
        item.className?.includes("cm-live-heading"),
    );
    const hidden = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "heading",
    );
    const collapsed = visual.filter(
      (item) => item.className === "cm-live-setext-underline",
    );

    expect(headingLines.map((item) => item.level)).toEqual([1, 2]);
    expect(hidden.map((item) => item.text)).toEqual(["===", "---"]);
    expect(collapsed).toHaveLength(2);
    expect(visual.some((item) => item.kind === "horizontal-rule")).toBe(false);
    expect(snapshots(result.atomicRanges, state)).toEqual(
      expect.arrayContaining(hidden),
    );

    const activeState = createState(doc, doc.indexOf("二级") + 1);
    const activeVisual = snapshots(build(activeState).decorations, activeState);
    expect(
      activeVisual
        .filter((item) => item.kind === "syntax" && item.owner === "heading")
        .map((item) => item.text),
    ).toEqual(["==="]);
    expect(
      activeVisual.filter(
        (item) => item.className === "cm-live-setext-underline",
      ),
    ).toHaveLength(1);
  });

  it("replaces standalone horizontal rules and restores their source for editing", () => {
    const doc = "上方\n\n---\n\n  * * *  \n\n下方光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const rules = snapshots(result.decorations, state).filter(
      (item) => item.kind === "horizontal-rule",
    );

    expect(rules.map((item) => item.text)).toEqual(["---", "  * * *  "]);
    expect(rules.every((item) => item.owner === "horizontal-rule")).toBe(true);
    expect(snapshots(result.atomicRanges, state)).toEqual(
      expect.arrayContaining(rules),
    );

    const activeState = createState(doc, doc.indexOf("---") + 1);
    expect(
      snapshots(build(activeState).decorations, activeState)
        .filter((item) => item.kind === "horizontal-rule")
        .map((item) => item.text),
    ).toEqual(["  * * *  "]);
    expect(
      snapshots(build(state, true).decorations, state).filter(
        (item) => item.kind === "horizontal-rule",
      ),
    ).toHaveLength(2);
    expect(state.doc.toString()).toBe(doc);
  });

  it("styles fenced code lines and replaces only the two fence lines", () => {
    const doc = "前文\n\n```ts\nconst x = 1\n```\n\n光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const codeLines = visual.filter(
      (item) => item.kind === "line" && item.owner === "fenced-code",
    );
    const hidden = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "fenced-code",
    );

    expect(codeLines.map((item) => item.codeLine)).toEqual([
      "start",
      "content",
      "end",
    ]);
    expect(hidden.map((item) => item.text)).toEqual(["```ts", "```"]);
    expect(hidden.every((item) => !item.text.includes("\n"))).toBe(true);
    expect(visual).toContainEqual(
      expect.objectContaining({
        kind: "code-language",
        owner: "fenced-code",
        language: "ts",
      }),
    );
  });

  it("reveals fenced code source while keeping its block styling active", () => {
    const doc = "```ts\nconst x = 1\n```\n\n尾";
    const state = createState(doc, doc.indexOf("x"));
    const visual = snapshots(build(state).decorations, state);

    expect(
      visual.some(
        (item) => item.kind === "syntax" && item.owner === "fenced-code",
      ),
    ).toBe(false);
    expect(
      visual.filter(
        (item) => item.kind === "line" && item.owner === "fenced-code",
      ),
    ).toHaveLength(3);
  });

  it("replaces a local image node with a resolved widget and restores source on edit", () => {
    const doc = '前 ![封面](post/cover.png "题注") 后，光标';
    const readyImage = () => ({
      status: "ready" as const,
      src: "blob:test-image",
    });
    const state = createState(doc, doc.length);
    const result = build(
      state,
      false,
      [{ from: 0, to: state.doc.length }],
      readyImage,
    );
    const image = snapshots(result.decorations, state).find(
      (item) => item.kind === "image",
    );

    expect(image).toEqual(
      expect.objectContaining({
        text: '![封面](post/cover.png "题注")',
        owner: "image",
        target: "post/cover.png",
        alt: "封面",
        title: "题注",
        imageStatus: "ready",
      }),
    );
    expect(snapshots(result.atomicRanges, state)).toContainEqual(image);

    const activeState = createState(doc, doc.indexOf("封面") + 1);
    expect(
      snapshots(
        build(
          activeState,
          false,
          [{ from: 0, to: activeState.doc.length }],
          readyImage,
        ).decorations,
        activeState,
      ).some((item) => item.kind === "image"),
    ).toBe(false);
  });

  it("keeps unrelated links, fences, and images rendered during IME composition", () => {
    const doc =
      "[链接](https://example.com) ![图](post/a.png)\n\n```ts\nx\n```\n\n尾";
    const state = createState(doc, doc.length);
    const visual = snapshots(
      build(state, true, [{ from: 0, to: state.doc.length }], () => ({
        status: "ready",
        src: "blob:test",
      })).decorations,
      state,
    );

    expect(visual.some((item) => item.kind === "syntax")).toBe(true);
    expect(visual.some((item) => item.kind === "image")).toBe(true);
    expect(visual.some((item) => item.kind === "code-language")).toBe(true);
  });

  it("reveals an image only when IME composition started inside its source", () => {
    const doc = "![图](post/a.png)\n\n![保留](post/b.png)\n\n输入位置";
    const state = createState(doc, doc.length);
    const visual = snapshots(
      build(
        state,
        true,
        [{ from: 0, to: state.doc.length }],
        () => ({ status: "ready", src: "blob:test" }),
        doc.indexOf("post/a.png"),
      ).decorations,
      state,
    );
    const images = visual.filter((item) => item.kind === "image");

    expect(images).toHaveLength(1);
    expect(images[0].target).toBe("post/b.png");
  });

  it("styles blockquotes and hides every quote marker as one atomic prefix", () => {
    const doc = "> 第一行\n> 第二行\n\n光标";
    const state = createState(doc, doc.length);
    const result = build(state);
    const visual = snapshots(result.decorations, state);
    const quoteMarkers = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "blockquote",
    );

    expect(quoteMarkers.map((item) => item.text)).toEqual(["> ", "> "]);
    expect(
      visual.filter(
        (item) => item.kind === "line" && item.owner === "blockquote",
      ),
    ).toHaveLength(2);
    expect(snapshots(result.atomicRanges, state)).toEqual(
      expect.arrayContaining(quoteMarkers),
    );

    const activeState = createState(doc, doc.indexOf("第二行") + 1);
    expect(
      snapshots(build(activeState).decorations, activeState).some(
        (item) => item.kind === "syntax" && item.owner === "blockquote",
      ),
    ).toBe(false);
  });

  it("renders bullet and ordered list markers while preserving nesting", () => {
    const doc = "- 第一项\n  - 嵌套项\n\n1. 有序\n2) 第二项\n\n光标";
    const state = createState(doc, doc.length);
    const markers = snapshots(build(state).decorations, state).filter(
      (item) => item.kind === "list-marker",
    );

    expect(markers.map((item) => item.text)).toEqual([
      "- ",
      "- ",
      "1. ",
      "2) ",
    ]);
    expect(markers.map((item) => item.marker)).toEqual(["•", "•", "1.", "2)"]);
    expect(markers.map((item) => item.listKind)).toEqual([
      "bullet",
      "bullet",
      "ordered",
      "ordered",
    ]);
  });

  it("renders interactive task markers and marks completed task text", () => {
    const doc = "- [ ] 待办\n- [X] 完成\n\n光标";
    const state = createState(doc, doc.length);
    const visual = snapshots(build(state).decorations, state);
    const checkboxes = visual.filter((item) => item.kind === "task-checkbox");
    const taskText = visual.filter(
      (item) => item.kind === "content" && item.owner === "task",
    );

    expect(checkboxes.map((item) => item.text)).toEqual(["[ ] ", "[X] "]);
    expect(checkboxes.map((item) => item.checked)).toEqual([false, true]);
    expect(taskText.map((item) => [item.text, item.checked])).toEqual([
      ["待办", false],
      ["完成", true],
    ]);

    const markerFrom = doc.indexOf("[ ]");
    const toggled = state.update({
      changes: taskToggleChange(markerFrom, true),
    }).state;
    expect(toggled.doc.toString()).toContain("- [x] 待办");
  });

  it("styles GFM tables, hides pipes, and collapses the separator row", () => {
    const doc = "| 名称 | 状态 |\n| --- | ---: |\n| 项目 | **完成** |\n\n光标";
    const state = createState(doc, doc.length);
    const visual = snapshots(build(state).decorations, state);
    const tableLines = visual.filter(
      (item) => item.kind === "line" && item.owner === "table",
    );
    const hidden = visual.filter(
      (item) => item.kind === "syntax" && item.owner === "table",
    );
    const cells = visual.filter(
      (item) => item.kind === "content" && item.owner === "table",
    );

    expect(tableLines.map((item) => item.tableLine)).toEqual([
      "header",
      "separator",
      "end",
    ]);
    expect(hidden.map((item) => item.text)).toEqual([
      "|",
      "|",
      "|",
      "| --- | ---: |",
      "|",
      "|",
      "|",
    ]);
    expect(hidden.every((item) => !item.text.includes("\n"))).toBe(true);
    expect(cells.map((item) => item.text)).toEqual([
      "名称",
      "状态",
      "项目",
      "**完成**",
    ]);

    const activeState = createState(doc, doc.indexOf("项目") + 1);
    expect(
      snapshots(build(activeState).decorations, activeState).some(
        (item) => item.kind === "syntax" && item.owner === "table",
      ),
    ).toBe(false);
  });

  it("keeps unrelated structural widgets rendered during IME composition", () => {
    const doc =
      "> 引用\n\n- 普通\n- [ ] 任务\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n光标";
    const state = createState(doc, doc.length);
    const visual = snapshots(build(state, true).decorations, state);

    expect(visual.some((item) => item.kind === "syntax")).toBe(true);
    expect(visual.some((item) => item.kind === "list-marker")).toBe(true);
    expect(visual.some((item) => item.kind === "task-checkbox")).toBe(true);
  });
});

describe("imageMimeType", () => {
  it("maps encoded image paths while ignoring query and fragment suffixes", () => {
    expect(imageMimeType("post/cover%20photo.PNG?width=800#hero")).toBe(
      "image/png",
    );
    expect(imageMimeType("post/vector.svg")).toBe("image/svg+xml");
    expect(imageMimeType("post/unknown.bin")).toBe("application/octet-stream");
  });
});

describe("selectionIntersectsNode", () => {
  it("treats cursor boundaries as active but excludes merely adjacent ranges", () => {
    const doc = "0123456789";
    expect(selectionIntersectsNode(createState(doc, 3), 3, 6)).toBe(true);
    expect(selectionIntersectsNode(createState(doc, 6), 3, 6)).toBe(true);
    expect(selectionIntersectsNode(createState(doc, 0, 3), 3, 6)).toBe(false);
    expect(selectionIntersectsNode(createState(doc, 6, 9), 3, 6)).toBe(false);
    expect(selectionIntersectsNode(createState(doc, 2, 4), 3, 6)).toBe(true);
  });
});
