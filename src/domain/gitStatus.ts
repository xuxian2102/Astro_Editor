import type { ChangeKind, FileChange, GitStatus } from "../lib/tauriApi";

export interface GroupedChanges {
  managed: FileChange[];
  other: FileChange[];
}

/** 拆成"编辑器管理"（会被 publish 暂存）和"仓库里其他改动"（仅供参考）两组 */
export function groupChanges(status: GitStatus): GroupedChanges {
  const managed: FileChange[] = [];
  const other: FileChange[] = [];
  for (const change of status.changes) {
    (change.managed ? managed : other).push(change);
  }
  return { managed, other };
}

const LABELS: Record<ChangeKind, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  untracked: "未跟踪",
  unmerged: "冲突",
};

export function changeLabel(kind: ChangeKind): string {
  return LABELS[kind] ?? kind;
}

export function canPublish(status: GitStatus): boolean {
  return groupChanges(status).managed.length > 0;
}
