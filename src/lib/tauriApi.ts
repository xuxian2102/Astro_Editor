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
}

export interface ProjectInfo {
  root: string;
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
  /** 落在 contentDir 内——只有这些会被 publish 暂存 */
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
    | "io"
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
  listPosts: () => invoke<PostSummary[]>("list_posts"),
  readPost: (id: string) => invoke<PostDocument>("read_post", { id }),
  writePost: (args: {
    id: string;
    rawFrontmatter: string | null;
    body: string;
    expectedRevision: string;
  }) => invoke<string>("write_post", args),
  createPost: (args: {
    id: string;
    rawFrontmatter: string | null;
    body: string;
  }) => invoke<PostDocument>("create_post", args),
  renamePost: (oldId: string, newId: string) =>
    invoke<PostSummary>("rename_post", { oldId, newId }),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitPublish: (message: string, push: boolean) =>
    invoke<PublishResult>("git_publish", { message, push }),
  ensurePreviewServer: (postId: string | null) =>
    invoke<PreviewStatus>("ensure_preview_server", { postId }),
  stopPreviewServer: () => invoke<PreviewStatus>("stop_preview_server"),
  getPreviewStatus: () => invoke<PreviewStatus>("get_preview_status"),
};
