import type { ChangeKind, FileChange, GitStatus } from "../lib/tauriApi";
import i18n from "../i18n";

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

export function changeLabel(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return i18n.t(($) => $.git.changes.added);
    case "modified":
      return i18n.t(($) => $.git.changes.modified);
    case "deleted":
      return i18n.t(($) => $.git.changes.deleted);
    case "renamed":
      return i18n.t(($) => $.git.changes.renamed);
    case "untracked":
      return i18n.t(($) => $.git.changes.untracked);
    case "unmerged":
      return i18n.t(($) => $.git.changes.unmerged);
    default:
      return kind;
  }
}

export function canPublish(status: GitStatus): boolean {
  return (
    !status.changes.some((change) => change.kind === "unmerged") &&
    groupChanges(status).managed.length > 0
  );
}
