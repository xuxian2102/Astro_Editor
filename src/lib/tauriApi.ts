import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

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
  error: AppErrorPayload | null;
}

/** 与 Rust 的 PreviewStatus 一致：Stopped → Starting → Ready → Stopping → Stopped */
export type PreviewStatus =
  | { phase: "stopped" }
  | { phase: "starting"; generation: number; startedAtMs: number }
  | { phase: "ready"; generation: number; url: string; pid: number }
  | { phase: "stopping"; generation: number }
  | {
      phase: "failed";
      generation: number;
      error: AppErrorPayload;
      logTail: string;
    };

export type AppErrorCode =
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
    | "git_unresolved_conflicts"
    | "git_nothing_to_commit"
    | "git_stage_failed"
    | "git_commit_failed"
    | "git_push_no_upstream"
    | "git_push_authentication_failed"
    | "git_push_failed"
    | "git_push_failed_detail"
    | "preview_port_in_use"
    | "preview_spawn_failed"
    | "preview_exited_early"
    | "preview_startup_timeout"
    | "preview_exited_unexpectedly"
    | (string & {});

export interface AppErrorPayload {
  code: AppErrorCode;
  params: Record<string, unknown>;
  fallback: string;
}

interface LegacyAppErrorPayload {
  code: AppErrorCode;
  message: string;
}

export function isAppError(
  e: unknown,
): e is AppErrorPayload | LegacyAppErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof e.code === "string" &&
    (("fallback" in e &&
      typeof e.fallback === "string" &&
      "params" in e &&
      typeof e.params === "object" &&
      e.params !== null &&
      !Array.isArray(e.params)) ||
      ("message" in e && typeof e.message === "string"))
  );
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    if ("fallback" in e) return translatedErrorMessage(e) ?? e.fallback;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function translatedErrorMessage(error: AppErrorPayload): string | null {
  switch (error.code) {
    case "no_project":
      return i18n.t(($) => $.backendErrors.noProject);
    case "stale_project_session":
      return i18n.t(($) => $.backendErrors.staleProjectSession);
    case "invalid_project":
      return translateDetail(error, ($) => $.backendErrors.invalidProject);
    case "config":
      return translateDetail(error, ($) => $.backendErrors.config);
    case "invalid_post_id":
      return translateParam(error, "id", ($) => $.backendErrors.invalidPostId);
    case "not_found":
      return translateParam(error, "id", ($) => $.backendErrors.notFound);
    case "already_exists":
      return translateParam(
        error,
        "target",
        ($) => $.backendErrors.alreadyExists,
      );
    case "external_modification_conflict":
      return i18n.t(($) => $.backendErrors.externalModificationConflict);
    case "io":
      return translateDetail(error, ($) => $.backendErrors.io);
    case "clipboard":
      return translateDetail(error, ($) => $.backendErrors.clipboard);
    case "git":
      return translateDetail(error, ($) => $.backendErrors.git);
    case "preview":
      return translateDetail(error, ($) => $.backendErrors.preview);
    case "git_unresolved_conflicts":
      return translateParam(
        error,
        "paths",
        ($) => $.backendErrors.gitUnresolvedConflicts,
      );
    case "git_nothing_to_commit":
      return i18n.t(($) => $.backendErrors.gitNothingToCommit);
    case "git_stage_failed":
      return translateDetail(error, ($) => $.backendErrors.gitStageFailed);
    case "git_commit_failed":
      return translateDetail(error, ($) => $.backendErrors.gitCommitFailed);
    case "git_push_no_upstream":
      return i18n.t(($) => $.backendErrors.gitPushNoUpstream);
    case "git_push_authentication_failed":
      return i18n.t(($) => $.backendErrors.gitPushAuthenticationFailed);
    case "git_push_failed":
      return i18n.t(($) => $.backendErrors.gitPushFailed);
    case "git_push_failed_detail":
      return translateDetail(error, ($) => $.backendErrors.gitPushFailedDetail);
    case "preview_port_in_use":
      return translateParam(
        error,
        "port",
        ($) => $.backendErrors.previewPortInUse,
      );
    case "preview_spawn_failed":
      return translateDetail(error, ($) => $.backendErrors.previewSpawnFailed);
    case "preview_exited_early":
      return translateParam(
        error,
        "exit",
        ($) => $.backendErrors.previewExitedEarly,
      );
    case "preview_startup_timeout":
      return translateParam(
        error,
        "seconds",
        ($) => $.backendErrors.previewStartupTimeout,
      );
    case "preview_exited_unexpectedly":
      return translateParam(
        error,
        "exit",
        ($) => $.backendErrors.previewExitedUnexpectedly,
      );
    default:
      return null;
  }
}

type ErrorSelector = Parameters<typeof i18n.t>[0];

function translateDetail(
  error: AppErrorPayload,
  selector: ErrorSelector,
): string | null {
  return translateParam(error, "detail", selector);
}

function translateParam(
  error: AppErrorPayload,
  name: string,
  selector: ErrorSelector,
): string | null {
  const value = error.params?.[name];
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return null;
  }
  return i18n.t(selector, { [name]: String(value) });
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
