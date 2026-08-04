import { describe, expect, it } from "vitest";
import { canPublish, changeLabel, groupChanges } from "./gitStatus";
import type { FileChange, GitStatus } from "../lib/tauriApi";

function change(overrides: Partial<FileChange>): FileChange {
  return {
    path: "a.md",
    oldPath: null,
    kind: "modified",
    staged: false,
    managed: true,
    ...overrides,
  };
}

function status(changes: FileChange[]): GitStatus {
  return { branch: "main", upstream: null, ahead: 0, behind: 0, changes };
}

describe("groupChanges", () => {
  it("按 managed 拆成两组，保持原有顺序", () => {
    const a = change({ path: "src/content/blog/a.md", managed: true });
    const b = change({ path: "README.md", managed: false });
    const c = change({ path: "src/content/blog/b.md", managed: true });

    const grouped = groupChanges(status([a, b, c]));
    expect(grouped.managed).toEqual([a, c]);
    expect(grouped.other).toEqual([b]);
  });

  it("空改动列表返回两个空数组", () => {
    const grouped = groupChanges(status([]));
    expect(grouped.managed).toEqual([]);
    expect(grouped.other).toEqual([]);
  });
});

describe("canPublish", () => {
  it("有 managed 改动时为 true", () => {
    expect(canPublish(status([change({ managed: true })]))).toBe(true);
  });

  it("只有非 managed 改动时为 false", () => {
    expect(canPublish(status([change({ managed: false })]))).toBe(false);
  });

  it("没有任何改动时为 false", () => {
    expect(canPublish(status([]))).toBe(false);
  });

  it("仓库存在未解决冲突时禁止发布，即使另有 managed 改动", () => {
    expect(
      canPublish(
        status([
          change({ path: "src/content/blog/a.md" }),
          change({ path: "README.md", kind: "unmerged", managed: false }),
        ]),
      ),
    ).toBe(false);
  });
});

describe("changeLabel", () => {
  it("映射到中文标签", () => {
    expect(changeLabel("added")).toBe("新增");
    expect(changeLabel("modified")).toBe("修改");
    expect(changeLabel("deleted")).toBe("删除");
    expect(changeLabel("renamed")).toBe("重命名");
    expect(changeLabel("untracked")).toBe("未跟踪");
    expect(changeLabel("unmerged")).toBe("冲突");
  });
});
