import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildLivePreviewDecorations } from "./livePreview";

const SECTION_COUNT = 7_000;
const VISIBLE_CHARACTER_BUDGET = 4_096;
const SAMPLE_COUNT = 120;
const FRAME_BUDGET_MS = 16;

function longMarkdown(): string {
  return Array.from({ length: SECTION_COUNT }, (_, index) =>
    [
      `## 第 ${index} 节`,
      "",
      "正文包含 **粗体**、*斜体*、~~删除线~~、[链接](https://example.com/" +
        index +
        ") 和 `代码`。",
      "",
      `> 引用 ${index}`,
      "",
      `- [ ] 待办 ${index}`,
      "",
      "| 名称 | 状态 |",
      "| --- | ---: |",
      `| 项目 ${index} | 完成 |`,
      "",
      "---",
      "",
    ].join("\n"),
  ).join("\n");
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

describe("live preview long-document performance", () => {
  it("keeps a fully parsed ~1 MiB document viewport rebuild within one frame", () => {
    const doc = longMarkdown();
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [markdown({ base: markdownLanguage })],
    });
    const parsed = ensureSyntaxTree(state, state.doc.length, 10_000);
    expect(parsed?.length).toBe(state.doc.length);
    if (!parsed) throw new Error("Markdown syntax tree did not finish");

    const middleLine = state.doc.lineAt(Math.floor(state.doc.length / 2));
    const visibleRanges = [
      {
        from: middleLine.from,
        to: Math.min(
          state.doc.length,
          middleLine.from + VISIBLE_CHARACTER_BUDGET,
        ),
      },
    ];
    const build = () =>
      buildLivePreviewDecorations({
        state,
        visibleRanges,
        composing: false,
        tree: parsed,
      });

    for (let warmup = 0; warmup < 20; warmup += 1) build();
    const samples: number[] = [];
    let decoratedRangeCount = 0;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      const result = build();
      samples.push(performance.now() - startedAt);
      let count = 0;
      for (
        let cursor = result.decorations.iter();
        cursor.value;
        cursor.next()
      ) {
        count += 1;
      }
      decoratedRangeCount = Math.max(decoratedRangeCount, count);
    }

    samples.sort((left, right) => left - right);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.info(
      `[live-preview-perf] ${(state.doc.length / 1024 / 1024).toFixed(2)} MiB, ` +
        `${VISIBLE_CHARACTER_BUDGET} visible chars, ${decoratedRangeCount} decorations, ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
    );

    expect(decoratedRangeCount).toBeGreaterThan(0);
    expect(p95).toBeLessThan(FRAME_BUDGET_MS);
  }, 15_000);
});
