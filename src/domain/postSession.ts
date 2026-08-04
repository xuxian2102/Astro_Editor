import type { PostDocument } from "../lib/tauriApi";
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
  revision: string;
}

export function sessionFromDocument(doc: PostDocument): PostSession {
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
    revision: doc.revision,
  };
}

export function isDirty(s: PostSession): boolean {
  return s.fmDirty || s.bodyDirty;
}

/** 保存时的 frontmatter 文本：没动过 → 原文；动过 → Document 序列化；空文档 → 无块 */
export function serializeFrontmatter(s: PostSession): string | null {
  if (!s.fmDoc) return s.rawFrontmatter;
  if (!s.fmDirty) return s.rawFrontmatter;
  if (s.fmDoc.isEmpty()) return null;
  return s.fmDoc.toString();
}

/** 保存成功后回写 session 状态 */
export function afterSave(
  s: PostSession,
  savedFrontmatter: string | null,
  newRevision: string,
): PostSession {
  return {
    ...s,
    rawFrontmatter: savedFrontmatter,
    fmDirty: false,
    bodyDirty: false,
    revision: newRevision,
  };
}
