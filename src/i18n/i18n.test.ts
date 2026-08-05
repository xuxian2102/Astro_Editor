import { describe, expect, it } from "vitest";
import i18n from ".";
import { zhCN } from "./zh-CN";

describe("i18n", () => {
  it("loads the default catalog synchronously", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t(($) => $.settings.title)).toBe(zhCN.settings.title);
  });

  it("interpolates values through typed catalog keys", () => {
    expect(
      i18n.t(($) => $.sidebar.renamePost, { id: "nested/post.md" }),
    ).toBe("重命名 nested/post.md");
  });
});
