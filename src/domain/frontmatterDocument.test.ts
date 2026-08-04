import { describe, expect, it } from "vitest";
import { FrontmatterDocument } from "./frontmatterDocument";

const RAW = `# 置顶注释
title: "带引号的标题"
pubDate: 2026-08-04
draft: false
customTool:
  nested: keep-me # 编辑器不认识的字段
tags:
  - astro
  - 'single-quoted'
`;

describe("FrontmatterDocument", () => {
  it("不改动时往返完全一致", () => {
    expect(FrontmatterDocument.parse(RAW).toString()).toBe(RAW);
  });

  it("改一个字段后：注释、顺序、引号、未识别字段全部保留", () => {
    const fm = FrontmatterDocument.parse(RAW);
    fm.set("title", "新标题");
    const out = fm.toString();

    expect(out).toContain("# 置顶注释");
    expect(out).toContain("nested: keep-me # 编辑器不认识的字段");
    expect(out).toContain("'single-quoted'");
    expect(out).toContain("pubDate: 2026-08-04");
    // 字段顺序不变
    expect(out.indexOf("title:")).toBeLessThan(out.indexOf("pubDate:"));
    expect(out.indexOf("pubDate:")).toBeLessThan(out.indexOf("draft:"));
    // 只有 title 变了
    expect(out).toContain("新标题");
    expect(out).not.toContain("带引号的标题");
  });

  it("读取各类型字段", () => {
    const fm = FrontmatterDocument.parse(RAW);
    expect(fm.getString("title")).toBe("带引号的标题");
    expect(fm.getString("pubDate")).toBe("2026-08-04");
    expect(fm.getBoolean("draft")).toBe(false);
    expect(fm.getTags("tags")).toEqual(["astro", "single-quoted"]);
    expect(fm.getString("不存在")).toBe("");
    expect(fm.getTags("不存在")).toEqual([]);
  });

  it("写入 tags 与 boolean", () => {
    const fm = FrontmatterDocument.parse(RAW);
    fm.set("tags", ["a", "b"]);
    fm.set("draft", true);
    const reparsed = FrontmatterDocument.parse(fm.toString());
    expect(reparsed.getTags("tags")).toEqual(["a", "b"]);
    expect(reparsed.getBoolean("draft")).toBe(true);
  });

  it("日期字符串写入后保持无引号的 plain scalar", () => {
    const fm = FrontmatterDocument.parse(RAW);
    fm.set("pubDate", "2026-12-31");
    expect(fm.toString()).toContain("pubDate: 2026-12-31");
  });

  it("空文档：isEmpty 为真，set 后能生成 YAML", () => {
    const fm = FrontmatterDocument.empty();
    expect(fm.isEmpty()).toBe(true);
    fm.set("title", "hello");
    expect(fm.isEmpty()).toBe(false);
    expect(fm.toString()).toBe("title: hello\n");
  });

  it("delete 移除字段但不影响其他内容", () => {
    const fm = FrontmatterDocument.parse(RAW);
    fm.delete("draft");
    const out = fm.toString();
    expect(out).not.toContain("draft:");
    expect(out).toContain("# 置顶注释");
    expect(out).toContain("nested: keep-me");
  });
});
