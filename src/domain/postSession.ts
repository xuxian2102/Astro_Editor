import type { DraftDocument, PostDocument } from "../lib/tauriApi";
import { FrontmatterDocument } from "./frontmatterDocument";

/**
 * 一篇打开的文章：正文 + frontmatter Document + revision + dirty 状态。
 * rawFrontmatter 始终是磁盘上的原始文本；表单没动过就原样写回，
 * 保证不被 yaml 库的任何规范化波及。
 */
export interface PostSession {
  id: string;
  body: string;
  rawFrontmatter: string | null;
  fmDoc: FrontmatterDocument | null;
  fmDirty: boolean;
  bodyDirty: boolean;
  /** 当前编辑会话内单调递增；用于识别异步保存之后发生的新编辑。 */
  editVersion: number;
  /** 仅文章切换/磁盘重载时变化；普通保存不得让 CodeMirror 重建。 */
  editorEpoch: number;
  projectGeneration: number;
  revision: string;
}

export interface PostSaveSnapshot {
  id: string;
  body: string;
  rawFrontmatter: string | null;
  expectedRevision: string;
  editVersion: number;
  projectGeneration: number;
}

export function sessionFromDocument(
  doc: PostDocument,
  editorEpoch = 0,
  projectGeneration = 0,
): PostSession {
  return {
    id: doc.id,
    body: doc.body,
    rawFrontmatter: doc.rawFrontmatter,
    fmDoc:
      doc.rawFrontmatter === null
        ? null
        : FrontmatterDocument.parse(doc.rawFrontmatter),
    fmDirty: false,
    bodyDirty: false,
    editVersion: 0,
    editorEpoch,
    projectGeneration,
    revision: doc.revision,
  };
}

export function draftMatchesDocument(
  draft: DraftDocument,
  document: PostDocument,
): boolean {
  return (
    draft.postId === document.id &&
    draft.rawFrontmatter === document.rawFrontmatter &&
    draft.body === document.body
  );
}

/** 用最新磁盘文档作为 revision 基线，把恢复内容标为尚未保存。 */
export function sessionFromDraft(
  document: PostDocument,
  draft: DraftDocument,
  editorEpoch = 0,
  projectGeneration = 0,
): PostSession {
  const session = sessionFromDocument(
    document,
    editorEpoch,
    projectGeneration,
  );
  const fmChanged = draft.rawFrontmatter !== document.rawFrontmatter;
  const bodyChanged = draft.body !== document.body;
  return {
    ...session,
    body: draft.body,
    fmDoc:
      draft.rawFrontmatter === null
        ? null
        : FrontmatterDocument.parse(draft.rawFrontmatter),
    fmDirty: fmChanged,
    bodyDirty: bodyChanged,
    editVersion: fmChanged || bodyChanged ? 1 : 0,
  };
}

export function isDirty(s: PostSession): boolean {
  return s.fmDirty || s.bodyDirty;
}

export function editorSessionKey(s: PostSession): string {
  return `${s.id}@${s.editorEpoch}`;
}

/** 保存时的 frontmatter 文本：没动过 → 原文；动过 → Document 序列化；空文档 → 无块 */
export function serializeFrontmatter(s: PostSession): string | null {
  if (!s.fmDoc) return s.fmDirty ? null : s.rawFrontmatter;
  if (!s.fmDirty) return s.rawFrontmatter;
  if (s.fmDoc.isEmpty()) return null;
  return s.fmDoc.toString();
}

/** 在发起 IO 前冻结真正写入磁盘的内容，之后的编辑不会改变这个快照。 */
export function createSaveSnapshot(s: PostSession): PostSaveSnapshot {
  return {
    id: s.id,
    body: s.body,
    rawFrontmatter: serializeFrontmatter(s),
    expectedRevision: s.revision,
    editVersion: s.editVersion,
    projectGeneration: s.projectGeneration,
  };
}

/**
 * 保存成功后把“已落盘基线”合并进当前 session，而不是拿请求开始时的旧 session
 * 覆盖当前编辑。保存期间继续输入的部分仍留在界面中，并继续保持 dirty。
 */
export function afterSave(
  current: PostSession,
  saved: PostSaveSnapshot,
  newRevision: string,
): PostSession {
  const currentFrontmatter = serializeFrontmatter(current);
  return {
    ...current,
    rawFrontmatter: saved.rawFrontmatter,
    fmDirty: currentFrontmatter !== saved.rawFrontmatter,
    bodyDirty: current.body !== saved.body,
    revision: newRevision,
  };
}
