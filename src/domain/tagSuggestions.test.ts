import { describe, expect, it } from "vitest";
import { filterSuggestions } from "./tagSuggestions";

describe("filterSuggestions", () => {
  const pool = ["Astro", "rust", "TypeScript", "教程"];

  it("大小写不敏感的子串匹配", () => {
    expect(filterSuggestions(pool, [], "ast")).toEqual(["Astro"]);
    expect(filterSuggestions(pool, [], "SCRIPT")).toEqual(["TypeScript"]);
    expect(filterSuggestions(pool, [], "教")).toEqual(["教程"]);
  });

  it("排除已选中的标签", () => {
    expect(filterSuggestions(pool, ["rust"], "")).toEqual([
      "Astro",
      "TypeScript",
      "教程",
    ]);
  });

  it("空 query 返回全部未选中候选", () => {
    expect(filterSuggestions(pool, [], "")).toEqual(pool);
    expect(filterSuggestions(pool, [], "   ")).toEqual(pool);
  });

  it("没有匹配项时返回空数组", () => {
    expect(filterSuggestions(pool, [], "nonexistent")).toEqual([]);
  });
});
