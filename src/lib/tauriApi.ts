import { invoke } from "@tauri-apps/api/core";

export interface FieldSpec {
  name: string;
  type: "string" | "date" | "boolean" | "tags" | (string & {});
  required: boolean;
  default?: unknown;
}

export interface PreviewConfig {
  command: string;
  args: string[];
  host: string;
  port: number;
  routeTemplate: string | null;
}

export interface ProjectConfig {
  version: number;
  contentDir: string;
  extensions: string[];
  frontmatter: { fields: FieldSpec[] };
  preview: PreviewConfig;
  assets: { mode: "colocated" };
}

export interface ProjectInfo {
  root: string;
  /** 后端每次选择项目递增；异步图片任务用它拒绝跨项目迟到写入。 */
  generation: number;
  config: ProjectConfig;
}

export interface PostSummary {
  id: string;
  relativePath: string;
  modifiedMs: number | null;
}

export interface PostDocument {
  id: string;
  relativePath: string;
  /** 不含 `---` 分隔线的原始 YAML；null 表示文件没有 frontmatter 块 */
  rawFrontmatter: string | null;
  body: string;
  /** 保存时回传，用于外部修改检测 */
  revision: string;
}

export interface DraftDocument {
  postId: string;
  rawFrontmatter: string | null;
  body: string;
  /** 自动草稿创建时，文章对应的磁盘 revision。 */
  baseRevision: string;
  savedAtMs: number;
}

export interface SavedImage {
  markdownPath: string;
}

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unmerged";

export interface FileChange {
  path: string;
  oldPath: string | null;
  kind: ChangeKind;
  staged: boolean;
  /** 落在 contentDir 内或是 .blog-editor.json——只有这些会被 publish 暂存 */
  managed: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: FileChange[];
}

export interface PublishResult {
  staged: boolean;
  stagedFiles: string[];
  committed: boolean;
  commitHash: string | null;
  pushed: boolean;
  /** "stage" | "commit" | "push"，null 表示全部成功（或未尝试推送） */
  errorStage: "stage" | "commit" | "push" | null;
  message: string | null;
}

/** 与 Rust 的 PreviewStatus 一致：Stopped → Starting → Ready → Stopping → Stopped */
export type PreviewStatus =
  | { phase: "stopped" }
  | { phase: "starting"; generation: number; startedAtMs: number }
  | { phase: "ready"; generation: number; url: string; pid: number }
  | { phase: "stopping"; generation: number }
  | { phase: "failed"; generation: number; message: string; logTail: string };

export interface AppErrorPayload {
  code:
    | "no_project"
    | "invalid_project"
    | "config"
    | "invalid_post_id"
    | "not_found"
    | "already_exists"
    | "external_modification_conflict"
    | "stale_project_session"
    | "io"
    | "clipboard"
    | "git"
    | "preview"
    | (string & {});
  message: string;
}

export function isAppError(e: unknown): e is AppErrorPayload {
  return (
    typeof e === "object" && e !== null && "code" in e && "message" in e
  );
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export const api = {
  selectProject: () => invoke<ProjectInfo | null>("select_project"),
  getProject: () => invoke<ProjectInfo | null>("get_project"),
  updateProjectConfig: (projectGeneration: number, config: ProjectConfig) =>
    invoke<ProjectInfo>("update_project_config", { projectGeneration, config }),
  listPosts: (projectGeneration: number) =>
    invoke<PostSummary[]>("list_posts", { projectGeneration }),
  readPost: (projectGeneration: number, id: string) =>
    invoke<PostDocument>("read_post", { projectGeneration, id }),
  writePost: (args: {
    projectGeneration: number;
    id: string;
    rawFrontmatter: string | null;
    body: string;
    expectedRevision: string;
  }) => invoke<string>("write_post", args),
  createPost: (args: {
    projectGeneration: number;
    id: string;
    rawFrontmatter: string | null;
    body: string;
  }) => invoke<PostDocument>("create_post", args),
  renamePost: (
    projectGeneration: number,
    oldId: string,
    newId: string,
    expectedRevision: string,
  ) =>
    invoke<PostDocument>("rename_post", {
      projectGeneration,
      oldId,
      newId,
      expectedRevision,
    }),
  deletePost: (
    projectGeneration: number,
    id: string,
    expectedRevision: string,
  ) => invoke<void>("delete_post", { projectGeneration, id, expectedRevision }),
  gitStatus: (projectGeneration: number) =>
    invoke<GitStatus>("git_status", { projectGeneration }),
  gitPublish: (projectGeneration: number, message: string, push: boolean) =>
    invoke<PublishResult>("git_publish", {
      projectGeneration,
      message,
      push,
    }),
  ensurePreviewServer: (projectGeneration: number, postId: string | null) =>
    invoke<PreviewStatus>("ensure_preview_server", {
      projectGeneration,
      postId,
    }),
  stopPreviewServer: () => invoke<PreviewStatus>("stop_preview_server"),
  getPreviewStatus: () => invoke<PreviewStatus>("get_preview_status"),
  /** 按字段名分组的标签索引，比如 { tags: [...], categories: [...] } */
  listTags: (projectGeneration: number) =>
    invoke<Record<string, string[]>>("list_tags", { projectGeneration }),
  /** 原始二进制 IPC，避免 Uint8Array → number[] → JSON 的多倍内存膨胀。 */
  saveImage: (
    projectGeneration: number,
    postId: string,
    suggestedName: string | null,
    bytes: Uint8Array,
  ) => {
    const headers: Record<string, string> = {
      "project-generation": String(projectGeneration),
      "post-id": encodeURIComponent(postId),
    };
    if (suggestedName !== null) {
      headers["suggested-name"] = encodeURIComponent(suggestedName);
    }
    return invoke<SavedImage>("save_image", bytes, { headers });
  },
  /** 只读取相对当前文章、且 canonicalize 后仍在 contentDir 内的图片原始字节。 */
  readImageAsset: (
    projectGeneration: number,
    postId: string,
    markdownPath: string,
  ) =>
    invoke<ArrayBuffer>("read_image_asset", {
      projectGeneration,
      postId,
      markdownPath,
    }),
  /** 原生读取剪贴板并保存图片；支持位图数据及文件管理器复制的一张或多张图片。 */
  importClipboardImages: (projectGeneration: number, postId: string) =>
    invoke<SavedImage[]>("import_clipboard_images", {
      projectGeneration,
      postId,
    }),
  /** 放弃当前文章编辑时，清理本会话新建且磁盘正文尚未引用的图片。 */
  discardPendingImages: (projectGeneration: number, postId: string) =>
    invoke<void>("discard_pending_images", { projectGeneration, postId }),
  writeDraft: (args: {
    projectGeneration: number;
    postId: string;
    rawFrontmatter: string | null;
    body: string;
    baseRevision: string;
  }) => invoke<void>("write_draft", args),
  readDraft: (projectGeneration: number, postId: string) =>
    invoke<DraftDocument | null>("read_draft", {
      projectGeneration,
      postId,
    }),
  deleteDraft: (projectGeneration: number, postId: string) =>
    invoke<void>("delete_draft", { projectGeneration, postId }),
};
