import { useCallback, useEffect, useState } from "react";
import {
  api,
  errorMessage,
  isAppError,
  type FieldSpec,
  type GitStatus,
  type PostSummary,
  type ProjectInfo,
  type PublishResult,
} from "./lib/tauriApi";
import {
  afterSave,
  isDirty,
  serializeFrontmatter,
  sessionFromDocument,
  type PostSession,
} from "./domain/postSession";
import { FrontmatterDocument } from "./domain/frontmatterDocument";
import MarkdownEditor from "./editor/MarkdownEditor";
import Sidebar from "./components/Sidebar";
import FrontmatterForm from "./components/FrontmatterForm";
import GitPanel from "./components/GitPanel";
import PreviewController from "./components/PreviewController";
import Modal from "./components/Modal";

type ModalState =
  | { kind: "conflict" }
  | { kind: "discard"; next: () => void };

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [session, setSession] = useState<PostSession | null>(null);
  /** 重载同一篇文章时也要重建编辑器，所以带上 revision */
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);

  const refreshPosts = useCallback(async () => {
    setPosts(await api.listPosts());
  }, []);

  /** git_status 失败（比如项目不是 git 仓库）只在 GitPanel 里提示，不打全局 error banner */
  const refreshGitStatus = useCallback(async () => {
    try {
      setGitStatus(await api.gitStatus());
      setGitStatusError(null);
    } catch (e) {
      setGitStatus(null);
      setGitStatusError(errorMessage(e));
    }
  }, []);

  // dev 模式下前端热重载后从 Rust 侧恢复已打开的项目
  useEffect(() => {
    api
      .getProject()
      .then(async (p) => {
        if (p) {
          setProject(p);
          await refreshPosts();
          await refreshGitStatus();
        }
      })
      .catch(() => {});
  }, [refreshPosts, refreshGitStatus]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const handleOpenProject = () =>
    run(async () => {
      const info = await api.selectProject();
      if (!info) return; // 用户取消
      setProject(info);
      setSession(null);
      setPublishResult(null);
      await refreshPosts();
      await refreshGitStatus();
    });

  const doOpenPost = useCallback(
    (id: string) =>
      run(async () => {
        setSession(sessionFromDocument(await api.readPost(id)));
      }),
    [run],
  );

  /** 有未保存改动时先经确认弹窗 */
  const guardDirty = (next: () => void) => {
    if (session && isDirty(session)) {
      setModal({ kind: "discard", next });
    } else {
      next();
    }
  };

  const handleSave = useCallback(() => {
    if (!session || saving) return;
    setSaving(true);
    run(async () => {
      const fm = serializeFrontmatter(session);
      try {
        const revision = await api.writePost({
          id: session.id,
          rawFrontmatter: fm,
          body: session.body,
          expectedRevision: session.revision,
        });
        setSession(afterSave(session, fm, revision));
        await refreshPosts();
        await refreshGitStatus();
      } catch (e) {
        if (isAppError(e) && e.code === "external_modification_conflict") {
          setModal({ kind: "conflict" });
          return;
        }
        throw e;
      }
    }).finally(() => setSaving(false));
  }, [session, saving, run, refreshPosts, refreshGitStatus]);

  /** 冲突：放弃本地改动，重新加载磁盘内容 */
  const conflictReload = () => {
    setModal(null);
    if (session) void doOpenPost(session.id);
  };

  /** 冲突：以本地内容覆盖磁盘（先取最新 revision 再写） */
  const conflictOverwrite = () => {
    setModal(null);
    if (!session) return;
    run(async () => {
      const fresh = await api.readPost(session.id);
      const fm = serializeFrontmatter(session);
      const revision = await api.writePost({
        id: session.id,
        rawFrontmatter: fm,
        body: session.body,
        expectedRevision: fresh.revision,
      });
      setSession(afterSave(session, fm, revision));
      await refreshPosts();
      await refreshGitStatus();
    });
  };

  const handleCreatePost = (name: string) =>
    run(async () => {
      if (!project) return;
      const id = ensureExtension(name, project.config.extensions);
      const fm = initialFrontmatter(project.config.frontmatter.fields, id);
      const doc = await api.createPost({
        id,
        rawFrontmatter: fm,
        body: "\n",
      });
      await refreshPosts();
      await refreshGitStatus();
      setSession(sessionFromDocument(doc));
    });

  const handleRenamePost = (oldId: string, newName: string) =>
    run(async () => {
      if (!project) return;
      const newId = ensureExtension(newName, project.config.extensions);
      if (newId === oldId) return;
      await api.renamePost(oldId, newId);
      await refreshPosts();
      await refreshGitStatus();
      if (session?.id === oldId) {
        setSession({ ...session, id: newId });
      }
    });

  const handlePublish = useCallback(
    (message: string, push: boolean) => {
      if (publishing) return;
      setPublishing(true);
      run(async () => {
        const result = await api.gitPublish(message, push);
        setPublishResult(result);
        await refreshGitStatus();
      }).finally(() => setPublishing(false));
    },
    [publishing, run, refreshGitStatus],
  );

  const handleBodyChange = useCallback((body: string) => {
    setSession((s) => (s ? { ...s, body, bodyDirty: true } : s));
  }, []);

  const handleFmEdit = (mutate: (fm: FrontmatterDocument) => void) => {
    if (!session?.fmDoc) return;
    mutate(session.fmDoc);
    setSession({ ...session, fmDirty: true });
  };

  const handleAddFrontmatter = () => {
    if (!session) return;
    setSession({ ...session, fmDoc: FrontmatterDocument.empty() });
  };

  const dirty = session ? isDirty(session) : false;

  return (
    <div className="app-shell">
      <div className="sidebar-column">
        <Sidebar
          project={project}
          posts={posts}
          activeId={session?.id ?? null}
          onOpenProject={() => guardDirty(handleOpenProject)}
          onOpenPost={(id) => {
            if (id !== session?.id) guardDirty(() => void doOpenPost(id));
          }}
          onCreatePost={(name) => guardDirty(() => void handleCreatePost(name))}
          onRenamePost={handleRenamePost}
        />
        {project && (
          <GitPanel
            status={gitStatus}
            statusError={gitStatusError}
            publishing={publishing}
            lastResult={publishResult}
            onPublish={handlePublish}
            onRefresh={() => void refreshGitStatus()}
          />
        )}
      </div>

      <main className="main-pane">
        <header className="toolbar">
          <span className="doc-title">
            {session ? session.id : project ? "选择一篇文章" : "先打开一个博客项目"}
            {dirty && <span className="dirty-dot" title="有未保存改动" />}
          </span>
          <div className="toolbar-actions">
            {project && <PreviewController activePostId={session?.id ?? null} />}
            {session && (
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty || saving}
                onClick={handleSave}
              >
                {saving ? "保存中…" : "保存 (Ctrl+S)"}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="error-banner">
            {error}
            <button type="button" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {session ? (
          <MarkdownEditor
            sessionKey={`${session.id}@${session.revision}`}
            initialBody={session.body}
            onChange={handleBodyChange}
            onSave={handleSave}
          />
        ) : (
          <div className="empty-state">
            {project
              ? "从左侧打开或新建一篇文章"
              : "打开一个包含 .blog-editor.json 的 Astro 博客项目"}
          </div>
        )}
      </main>

      {session && project && (
        <aside className="fm-pane">
          <h2>Frontmatter</h2>
          <FrontmatterForm
            fields={project.config.frontmatter.fields}
            session={session}
            onEdit={handleFmEdit}
            onAddFrontmatter={handleAddFrontmatter}
          />
        </aside>
      )}

      {modal?.kind === "conflict" && (
        <Modal
          title="文件在外部被修改"
          message="磁盘上的内容与打开时不一致（可能来自 git 操作或其他编辑器）。保存已中止，请选择处理方式。"
          actions={[
            { label: "重新加载（丢弃我的改动）", onClick: conflictReload },
            {
              label: "用我的版本覆盖",
              kind: "danger",
              onClick: conflictOverwrite,
            },
          ]}
        />
      )}
      {modal?.kind === "discard" && (
        <Modal
          title="有未保存的改动"
          message="当前文章有未保存的改动，继续将丢弃这些改动。"
          actions={[
            { label: "取消", onClick: () => setModal(null) },
            {
              label: "丢弃改动并继续",
              kind: "danger",
              onClick: () => {
                const next = modal.next;
                setModal(null);
                next();
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function ensureExtension(name: string, extensions: string[]): string {
  const hasAllowed = extensions.some((ext) =>
    name.endsWith(ext.startsWith(".") ? ext : `.${ext}`),
  );
  if (hasAllowed) return name;
  const first = extensions[0] ?? ".md";
  return name + (first.startsWith(".") ? first : `.${first}`);
}

/** 按配置字段生成新文章的初始 frontmatter */
function initialFrontmatter(fields: FieldSpec[], id: string): string | null {
  const fm = FrontmatterDocument.empty();
  const stem = id.split("/").pop()?.replace(/\.[^.]+$/, "") ?? id;
  for (const field of fields) {
    if (field.type === "string" && field.name === "title") {
      fm.set(field.name, stem);
    } else if (field.default !== undefined && field.default !== null) {
      fm.set(field.name, field.default);
    } else if (field.type === "date") {
      fm.set(field.name, new Date().toISOString().slice(0, 10));
    } else if (field.required) {
      fm.set(
        field.name,
        field.type === "boolean" ? false : field.type === "tags" ? [] : "",
      );
    }
  }
  return fm.isEmpty() ? null : fm.toString();
}
