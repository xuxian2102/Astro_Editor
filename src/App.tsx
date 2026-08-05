import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import FrontmatterForm from "./components/FrontmatterForm";
import GitPanel from "./components/GitPanel";
import Modal from "./components/Modal";
import PreviewController from "./components/PreviewController";
import ProjectSettingsDialog from "./components/ProjectSettingsDialog";
import Sidebar from "./components/Sidebar";
import { FrontmatterDocument } from "./domain/frontmatterDocument";
import {
  afterSave,
  createSaveSnapshot,
  draftMatchesDocument,
  editorSessionKey,
  isDirty,
  type PostSaveSnapshot,
  type PostSession,
  sessionFromDocument,
  sessionFromDraft,
} from "./domain/postSession";
import MarkdownEditor from "./editor/MarkdownEditor";
import {
  api,
  type DraftDocument,
  errorMessage,
  type FieldSpec,
  type GitStatus,
  isAppError,
  type PostDocument,
  type PostSummary,
  type ProjectConfig,
  type ProjectInfo,
  type PublishResult,
} from "./lib/tauriApi";

type ModalState =
  | { kind: "conflict" }
  | { kind: "close" }
  | {
      kind: "recovery";
      document: PostDocument;
      draft: DraftDocument;
      editorEpoch: number;
      projectGeneration: number;
    }
  | {
      kind: "discard";
      postId: string;
      projectGeneration: number;
      next: (fresh?: PostDocument) => void | Promise<void>;
    }
  | {
      kind: "delete";
      id: string;
      expectedRevision: string;
      projectGeneration: number;
      hasUnsavedChanges: boolean;
    };

type SessionUpdate =
  | PostSession
  | null
  | ((current: PostSession | null) => PostSession | null);

export default function App() {
  const { t } = useTranslation();
  const [project, setRenderedProject] = useState<ProjectInfo | null>(null);
  const projectRef = useRef<ProjectInfo | null>(null);
  projectRef.current = project;
  const setProject = useCallback((next: ProjectInfo | null) => {
    projectRef.current = next;
    setRenderedProject(next);
  }, []);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [session, setRenderedSession] = useState<PostSession | null>(null);
  // React state 负责渲染，ref 负责异步操作完成当下读取最新编辑内容，避免闭包旧值。
  const sessionRef = useRef<PostSession | null>(null);
  const editorEpochRef = useRef(0);
  const setSession = useCallback((update: SessionUpdate) => {
    const next =
      typeof update === "function" ? update(sessionRef.current) : update;
    sessionRef.current = next;
    setRenderedSession(next);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const saveRequestRef = useRef(0);
  const saveRequiresCleanRef = useRef(false);
  const pendingImageOperationsRef = useRef(new Set<Promise<unknown>>());
  const postOpenRequestRef = useRef(0);
  const postsRefreshRequestRef = useRef(0);
  const tagsRefreshRequestRef = useRef(0);
  const gitRefreshRequestRef = useRef(0);
  const [pendingImageCount, setPendingImageCount] = useState(0);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(
    null,
  );
  const [tagSuggestions, setTagSuggestions] = useState<
    Record<string, string[]>
  >({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const draftTimerRef = useRef<number | null>(null);
  const draftQueueRef = useRef<Promise<void>>(Promise.resolve());

  const cancelScheduledDraft = useCallback(() => {
    if (draftTimerRef.current === null) return;
    window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
  }, []);

  /** 草稿写入和删除严格排队，保证正常保存后的 delete 不会被旧写入反超。 */
  const enqueueDraftOperation = useCallback(<T,>(action: () => Promise<T>) => {
    const result = draftQueueRef.current.then(action, action);
    draftQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const waitForDraftQueue = useCallback(() => draftQueueRef.current, []);

  const loadSession = useCallback(
    async (document: PostDocument, recoverDraft = true) => {
      editorEpochRef.current += 1;
      const editorEpoch = editorEpochRef.current;
      const projectGeneration = projectRef.current?.generation ?? 0;
      setModal((current) => (current?.kind === "recovery" ? null : current));
      setSession(sessionFromDocument(document, editorEpoch, projectGeneration));

      if (!recoverDraft || projectGeneration === 0) return;
      try {
        const draft = await enqueueDraftOperation(() =>
          api.readDraft(projectGeneration, document.id),
        );
        const current = sessionRef.current;
        if (
          !current ||
          current.id !== document.id ||
          current.editorEpoch !== editorEpoch ||
          current.projectGeneration !== projectGeneration ||
          current.editVersion !== 0
        ) {
          return;
        }
        if (!draft) return;
        if (draftMatchesDocument(draft, document)) {
          await enqueueDraftOperation(() =>
            api.deleteDraft(projectGeneration, document.id),
          );
          return;
        }
        setModal(
          (currentModal) =>
            currentModal ?? {
              kind: "recovery",
              document,
              draft,
              editorEpoch,
              projectGeneration,
            },
        );
      } catch (e) {
        if (isAppError(e) && e.code === "stale_project_session") return;
        setError(
          t(($) => $.app.errors.draftReadFailed, { error: errorMessage(e) }),
        );
      }
    },
    [enqueueDraftOperation, setSession, t],
  );

  useEffect(() => {
    cancelScheduledDraft();
    if (!session || !isDirty(session)) return;

    const snapshot = createSaveSnapshot(session);
    const timer = window.setTimeout(() => {
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
      const operation = enqueueDraftOperation(() =>
        api.writeDraft({
          projectGeneration: snapshot.projectGeneration,
          postId: snapshot.id,
          rawFrontmatter: snapshot.rawFrontmatter,
          body: snapshot.body,
          baseRevision: snapshot.expectedRevision,
        }),
      );
      void operation.catch((e) => {
        if (isAppError(e) && e.code === "stale_project_session") return;
        const current = sessionRef.current;
        if (
          current?.id === snapshot.id &&
          current.projectGeneration === snapshot.projectGeneration
        ) {
          setError(
            (existing) =>
              existing ??
              t(($) => $.app.errors.draftAutosaveFailed, {
                error: errorMessage(e),
              }),
          );
        }
      });
    }, 700);
    draftTimerRef.current = timer;

    return () => {
      if (draftTimerRef.current === timer) {
        window.clearTimeout(timer);
        draftTimerRef.current = null;
      }
    };
  }, [cancelScheduledDraft, enqueueDraftOperation, session, t]);

  const registerImageOperation = useCallback((operation: Promise<unknown>) => {
    const operations = pendingImageOperationsRef.current;
    if (operations.has(operation)) return;
    operations.add(operation);
    setPendingImageCount(operations.size);

    const finish = () => {
      operations.delete(operation);
      setPendingImageCount(operations.size);
    };
    operation.then(finish, finish);
  }, []);

  const waitForPendingImages = useCallback(async () => {
    // 一个操作收尾时可能同步登记下一项，所以直到集合真正为空才返回。
    while (pendingImageOperationsRef.current.size > 0) {
      await Promise.allSettled([...pendingImageOperationsRef.current]);
    }
  }, []);

  const refreshPosts = useCallback(async () => {
    const request = ++postsRefreshRequestRef.current;
    const currentProject = projectRef.current;
    if (!currentProject) {
      setPosts([]);
      return;
    }
    const generation = currentProject.generation;
    try {
      const nextPosts = await api.listPosts(generation);
      if (
        request === postsRefreshRequestRef.current &&
        projectRef.current?.generation === generation
      ) {
        setPosts(nextPosts);
      }
    } catch (e) {
      if (
        request === postsRefreshRequestRef.current &&
        projectRef.current?.generation === generation
      ) {
        throw e;
      }
    }
  }, []);

  const refreshTags = useCallback(async () => {
    const request = ++tagsRefreshRequestRef.current;
    const currentProject = projectRef.current;
    if (!currentProject) {
      setTagSuggestions({});
      return;
    }
    const generation = currentProject.generation;
    try {
      const suggestions = await api.listTags(generation);
      if (
        request === tagsRefreshRequestRef.current &&
        projectRef.current?.generation === generation
      ) {
        setTagSuggestions(suggestions);
      }
    } catch {
      // 标签索引只是辅助功能，读取失败不打断主流程
    }
  }, []);

  /** git_status 失败（比如项目不是 git 仓库）只在 GitPanel 里提示，不打全局 error banner */
  const refreshGitStatus = useCallback(async () => {
    const request = ++gitRefreshRequestRef.current;
    const currentProject = projectRef.current;
    if (!currentProject) {
      setGitStatus(null);
      setGitStatusError(null);
      return;
    }
    const generation = currentProject.generation;
    try {
      const status = await api.gitStatus(generation);
      if (
        request === gitRefreshRequestRef.current &&
        projectRef.current?.generation === generation
      ) {
        setGitStatus(status);
        setGitStatusError(null);
      }
    } catch (e) {
      if (
        request === gitRefreshRequestRef.current &&
        projectRef.current?.generation === generation
      ) {
        setGitStatus(null);
        setGitStatusError(errorMessage(e));
      }
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
          await refreshTags();
        }
      })
      .catch(() => {});
  }, [refreshPosts, refreshGitStatus, refreshTags, setProject]);

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
      postOpenRequestRef.current += 1;
      await waitForPendingImages();
      cancelScheduledDraft();
      await waitForDraftQueue();
      const info = await api.selectProject();
      if (!info) return; // 用户取消
      setProject(info);
      setSession(null);
      setPublishResult(null);
      await refreshPosts();
      await refreshGitStatus();
      await refreshTags();
    });

  const doOpenPost = useCallback(
    (id: string) =>
      run(async () => {
        const request = ++postOpenRequestRef.current;
        await waitForPendingImages();
        const current = sessionRef.current;
        const projectGeneration =
          current?.projectGeneration ?? projectRef.current?.generation;
        if (projectGeneration === undefined) return;
        if (current && current.id !== id) {
          await api.discardPendingImages(current.projectGeneration, current.id);
        }
        const document = await api.readPost(projectGeneration, id);
        if (
          request !== postOpenRequestRef.current ||
          projectRef.current?.generation !== projectGeneration
        ) {
          return;
        }
        await loadSession(document);
      }),
    [loadSession, run, waitForPendingImages],
  );

  /** 有未保存改动时先经确认弹窗 */
  const guardDirty = (next: (fresh?: PostDocument) => void | Promise<void>) => {
    if (
      session &&
      (isDirty(session) || pendingImageOperationsRef.current.size > 0)
    ) {
      setModal({
        kind: "discard",
        postId: session.id,
        projectGeneration: session.projectGeneration,
        next,
      });
    } else {
      void next();
    }
  };

  const writeSnapshot = useCallback(
    async (snapshot: PostSaveSnapshot, expectedRevision: string) => {
      const revision = await api.writePost({
        projectGeneration: snapshot.projectGeneration,
        id: snapshot.id,
        rawFrontmatter: snapshot.rawFrontmatter,
        body: snapshot.body,
        expectedRevision,
      });
      setSession((current) =>
        current?.id === snapshot.id
          ? afterSave(current, snapshot, revision)
          : current,
      );
      try {
        await enqueueDraftOperation(() =>
          api.deleteDraft(snapshot.projectGeneration, snapshot.id),
        );
      } catch {
        // 正文已经落盘，草稿清理失败不能把一次成功保存伪装成冲突；下次打开会再次清理。
      }
      await Promise.allSettled([
        refreshPosts(),
        refreshGitStatus(),
        refreshTags(),
      ]);
    },
    [
      enqueueDraftOperation,
      refreshGitStatus,
      refreshPosts,
      refreshTags,
      setSession,
    ],
  );

  const requestSave = useCallback(
    (requireClean: boolean): Promise<boolean> => {
      saveRequestRef.current += 1;
      if (requireClean) saveRequiresCleanRef.current = true;
      if (saveInFlightRef.current) return saveInFlightRef.current;

      setSaving(true);
      setError(null);
      const operation = (async () => {
        while (true) {
          const handledRequest = saveRequestRef.current;
          await waitForPendingImages();
          cancelScheduledDraft();
          const current = sessionRef.current;
          if (!current || !isDirty(current)) return true;
          const snapshot = createSaveSnapshot(current);

          try {
            await writeSnapshot(snapshot, snapshot.expectedRevision);
          } catch (e) {
            if (isAppError(e) && e.code === "external_modification_conflict") {
              setModal({ kind: "conflict" });
              return false;
            }
            setError(errorMessage(e));
            return false;
          }

          const latest = sessionRef.current;
          const anotherSaveWasRequested =
            saveRequestRef.current !== handledRequest;
          const barrierStillDirty =
            saveRequiresCleanRef.current && !!latest && isDirty(latest);
          if (!anotherSaveWasRequested && !barrierStillDirty) return true;
        }
      })();
      saveInFlightRef.current = operation;
      void operation.finally(() => {
        if (saveInFlightRef.current === operation) {
          saveInFlightRef.current = null;
          saveRequiresCleanRef.current = false;
        }
        setSaving(false);
      });
      return operation;
    },
    [cancelScheduledDraft, waitForPendingImages, writeSnapshot],
  );

  const handleSave = useCallback(() => {
    void requestSave(false);
  }, [requestSave]);

  /** 预览/发布的保存屏障：返回 true 时保证 pending 图片已完成且当前文章是 clean。 */
  const ensureSaved = useCallback(() => requestSave(true), [requestSave]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        const current = sessionRef.current;
        const hasWork =
          !!current &&
          (isDirty(current) ||
            pendingImageOperationsRef.current.size > 0 ||
            saveInFlightRef.current !== null);
        if (!hasWork) return;
        event.preventDefault();
        setModal({ kind: "close" });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // 普通浏览器开发模式没有 Tauri 窗口事件；桌面构建中会正常注册。
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const saveAndClose = () => {
    setModal(null);
    void (async () => {
      if (await ensureSaved()) await getCurrentWindow().destroy();
    })();
  };

  const discardAndClose = () => {
    setModal(null);
    void (async () => {
      await waitForPendingImages();
      cancelScheduledDraft();
      await waitForDraftQueue();
      const current = sessionRef.current;
      if (current) {
        try {
          await enqueueDraftOperation(() =>
            api.deleteDraft(current.projectGeneration, current.id),
          );
          await api.discardPendingImages(current.projectGeneration, current.id);
        } catch {
          // 用户已明确选择放弃；退出时 Rust 仍会再次尽力清理 pending 图片。
        }
      }
      await getCurrentWindow().destroy();
    })();
  };

  /** 冲突：放弃本地改动，重新加载磁盘内容 */
  const conflictReload = () => {
    postOpenRequestRef.current += 1;
    setModal(null);
    const current = sessionRef.current;
    if (!current) return;
    const postId = current.id;
    const projectGeneration = current.projectGeneration;
    void run(async () => {
      await waitForPendingImages();
      // 先读磁盘版本；确认可恢复后再删除本次编辑遗留、且磁盘正文没有引用的图片。
      const fresh = await api.readPost(projectGeneration, postId);
      await api.discardPendingImages(projectGeneration, postId);
      cancelScheduledDraft();
      await waitForDraftQueue();
      await enqueueDraftOperation(() =>
        api.deleteDraft(projectGeneration, postId),
      );
      await loadSession(fresh, false);
    });
  };

  /** 冲突：以本地内容覆盖磁盘（先取最新 revision 再写） */
  const conflictOverwrite = () => {
    setModal(null);
    if (!sessionRef.current || saveInFlightRef.current) return;
    setSaving(true);
    setError(null);
    const operation = (async () => {
      try {
        await waitForPendingImages();
        cancelScheduledDraft();
        const current = sessionRef.current;
        if (!current) return true;
        const snapshot = createSaveSnapshot(current);
        const fresh = await api.readPost(
          snapshot.projectGeneration,
          snapshot.id,
        );
        await writeSnapshot(snapshot, fresh.revision);
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    })();
    saveInFlightRef.current = operation;
    void operation.finally(() => {
      if (saveInFlightRef.current === operation) {
        saveInFlightRef.current = null;
        saveRequiresCleanRef.current = false;
      }
      setSaving(false);
    });
  };

  const handleCreatePost = (name: string) =>
    run(async () => {
      postOpenRequestRef.current += 1;
      if (!project) return;
      await waitForPendingImages();
      cancelScheduledDraft();
      await waitForDraftQueue();
      const current = sessionRef.current;
      if (current) {
        await api.discardPendingImages(current.projectGeneration, current.id);
      }
      const id = ensureExtension(name, project.config.extensions);
      const fm = initialFrontmatter(project.config.frontmatter.fields, id);
      const doc = await api.createPost({
        projectGeneration: project.generation,
        id,
        rawFrontmatter: fm,
        body: "\n",
      });
      await refreshPosts();
      await refreshGitStatus();
      await refreshTags();
      await loadSession(doc, false);
    });

  const handleRenamePost = (
    oldId: string,
    newName: string,
    discardedDocument?: PostDocument,
  ) =>
    run(async () => {
      postOpenRequestRef.current += 1;
      if (!project) return;
      await waitForPendingImages();
      const newId = ensureExtension(newName, project.config.extensions);
      if (newId === oldId) return;
      const expectedRevision =
        discardedDocument?.revision ??
        (session?.id === oldId
          ? session.revision
          : (await api.readPost(project.generation, oldId)).revision);
      const document = await api.renamePost(
        project.generation,
        oldId,
        newId,
        expectedRevision,
      );
      await refreshPosts();
      await refreshGitStatus();
      await refreshTags();
      try {
        await enqueueDraftOperation(() =>
          api.deleteDraft(project.generation, oldId),
        );
      } catch {
        // 重命名已经完成；遗留的旧 ID 草稿无法再匹配新文章，不影响正文结果。
      }
      await loadSession(document, false);
    });

  const requestDeletePost = (id: string) => {
    if (!session || session.id !== id) return;
    setModal({
      kind: "delete",
      id,
      expectedRevision: session.revision,
      projectGeneration: session.projectGeneration,
      hasUnsavedChanges:
        isDirty(session) || pendingImageOperationsRef.current.size > 0,
    });
  };

  const confirmDeletePost = () => {
    if (modal?.kind !== "delete") return;
    const { id, expectedRevision, projectGeneration } = modal;
    setModal(null);
    postOpenRequestRef.current += 1;
    void run(async () => {
      await waitForPendingImages();
      cancelScheduledDraft();
      await waitForDraftQueue();
      await api.deletePost(projectGeneration, id, expectedRevision);
      try {
        await enqueueDraftOperation(() =>
          api.deleteDraft(projectGeneration, id),
        );
      } catch {
        // 文章已经进入废纸篓，草稿清理失败不改变删除结果。
      }
      setSession((current) => (current?.id === id ? null : current));
      try {
        await api.stopPreviewServer();
      } catch {
        // 文章已安全移到废纸篓；预览清理失败不应把删除结果伪装成失败。
      }
      await refreshPosts();
      await refreshGitStatus();
      await refreshTags();
    });
  };

  const handlePublish = useCallback(
    (message: string, push: boolean) => {
      if (publishing) return;
      setPublishing(true);
      run(async () => {
        const projectGeneration = projectRef.current?.generation;
        if (projectGeneration === undefined) return;
        if (!(await ensureSaved())) return;
        const result = await api.gitPublish(projectGeneration, message, push);
        if (projectRef.current?.generation === projectGeneration) {
          setPublishResult(result);
        }
        await refreshGitStatus();
      }).finally(() => setPublishing(false));
    },
    [publishing, run, refreshGitStatus, ensureSaved],
  );

  const handleSaveProjectSettings = useCallback(
    async (config: ProjectConfig) => {
      if (settingsSaving) return;
      setSettingsSaving(true);
      setSettingsError(null);
      try {
        const projectGeneration = projectRef.current?.generation;
        if (projectGeneration === undefined) return;
        const updated = await api.updateProjectConfig(
          projectGeneration,
          config,
        );
        setProject(updated);
        setSettingsOpen(false);
        // extensions / fields 都可能改变派生列表；配置文件本身也会出现在 Git 状态中。
        try {
          await refreshPosts();
        } catch (e) {
          setError(errorMessage(e));
        }
        await refreshGitStatus();
        await refreshTags();
      } catch (e) {
        setSettingsError(errorMessage(e));
      } finally {
        setSettingsSaving(false);
      }
    },
    [settingsSaving, refreshPosts, refreshGitStatus, refreshTags, setProject],
  );

  const handleBodyChange = useCallback(
    (body: string) => {
      setSession((current) => {
        if (!current || current.body === body) return current;
        return {
          ...current,
          body,
          bodyDirty: true,
          editVersion: current.editVersion + 1,
        };
      });
    },
    [setSession],
  );

  const handleFmEdit = (mutate: (fm: FrontmatterDocument) => void) => {
    setSession((current) => {
      if (!current?.fmDoc) return current;
      const fmDoc = current.fmDoc.clone();
      mutate(fmDoc);
      return {
        ...current,
        fmDoc,
        fmDirty: true,
        editVersion: current.editVersion + 1,
      };
    });
  };

  const handleAddFrontmatter = () => {
    setSession((current) =>
      current
        ? {
            ...current,
            fmDoc: FrontmatterDocument.empty(),
            fmDirty: true,
            editVersion: current.editVersion + 1,
          }
        : current,
    );
  };

  const restoreRecoveryDraft = () => {
    if (modal?.kind !== "recovery") return;
    const { document, draft, editorEpoch, projectGeneration } = modal;
    setModal(null);
    const current = sessionRef.current;
    if (
      !current ||
      current.id !== document.id ||
      current.editorEpoch !== editorEpoch ||
      current.projectGeneration !== projectGeneration
    ) {
      return;
    }
    try {
      editorEpochRef.current += 1;
      setSession(
        sessionFromDraft(
          document,
          draft,
          editorEpochRef.current,
          projectGeneration,
        ),
      );
    } catch (e) {
      setError(
        t(($) => $.app.errors.draftRestoreFailed, {
          error: errorMessage(e),
        }),
      );
    }
  };

  const keepDiskVersion = () => {
    if (modal?.kind !== "recovery") return;
    const { document, projectGeneration } = modal;
    setModal(null);
    cancelScheduledDraft();
    void run(async () => {
      await enqueueDraftOperation(() =>
        api.deleteDraft(projectGeneration, document.id),
      );
    });
  };

  const dirty = session ? isDirty(session) : false;
  const hasUnsavedWork = dirty || pendingImageCount > 0;

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
          onRenamePost={(oldId, newName) =>
            guardDirty((fresh) => handleRenamePost(oldId, newName, fresh))
          }
          onDeletePost={requestDeletePost}
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
            {session
              ? session.id
              : project
                ? t(($) => $.app.toolbar.selectPost)
                : t(($) => $.app.toolbar.openProjectFirst)}
            {hasUnsavedWork && (
              <span
                className="dirty-dot"
                title={t(($) => $.app.toolbar.unsavedTitle)}
              />
            )}
          </span>
          <div className="toolbar-actions">
            {project && (
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setSettingsError(null);
                  setSettingsOpen(true);
                }}
              >
                {t(($) => $.app.toolbar.projectSettings)}
              </button>
            )}
            {session && (
              <button
                type="button"
                className="editor-mode-toggle"
                aria-pressed={livePreviewEnabled}
                title={t(($) => $.app.toolbar.livePreviewHint)}
                onClick={() => setLivePreviewEnabled((enabled) => !enabled)}
              >
                {t(($) => $.app.toolbar.livePreview, {
                  state: livePreviewEnabled
                    ? t(($) => $.app.toolbar.on)
                    : t(($) => $.app.toolbar.off),
                })}
              </button>
            )}
            {project && (
              <PreviewController
                projectGeneration={project.generation}
                activePostId={session?.id ?? null}
                beforePreview={ensureSaved}
              />
            )}
            {session && (
              <button
                type="button"
                className="btn-primary"
                disabled={!hasUnsavedWork || saving}
                onClick={handleSave}
              >
                {saving && pendingImageCount > 0
                  ? t(($) => $.app.toolbar.waitingImages)
                  : saving
                    ? t(($) => $.common.saving)
                    : t(($) => $.app.toolbar.save)}
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
            sessionKey={editorSessionKey(session)}
            postId={session.id}
            projectGeneration={session.projectGeneration}
            initialBody={session.body}
            livePreviewEnabled={livePreviewEnabled}
            onChange={handleBodyChange}
            onSave={handleSave}
            onImageError={setError}
            onImageOperation={registerImageOperation}
          />
        ) : (
          <div className="empty-state">
            {project
              ? t(($) => $.app.empty.selectPost)
              : t(($) => $.app.empty.openProject)}
          </div>
        )}
      </main>

      {session && project && (
        <aside className="fm-pane">
          <h2>{t(($) => $.frontmatter.title)}</h2>
          <FrontmatterForm
            fields={project.config.frontmatter.fields}
            session={session}
            onEdit={handleFmEdit}
            onAddFrontmatter={handleAddFrontmatter}
            tagSuggestions={tagSuggestions}
          />
        </aside>
      )}

      {settingsOpen && project && (
        <ProjectSettingsDialog
          project={project}
          activePostId={session?.id ?? null}
          saving={settingsSaving}
          serverError={settingsError}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsError(null);
          }}
          onSave={(config) => void handleSaveProjectSettings(config)}
        />
      )}

      {modal?.kind === "conflict" && (
        <Modal
          title={t(($) => $.app.dialogs.conflict.title)}
          message={t(($) => $.app.dialogs.conflict.message)}
          actions={[
            {
              label: t(($) => $.app.dialogs.conflict.reload),
              onClick: conflictReload,
            },
            {
              label: t(($) => $.app.dialogs.conflict.overwrite),
              kind: "danger",
              onClick: conflictOverwrite,
            },
          ]}
        />
      )}
      {modal?.kind === "recovery" && (
        <Modal
          title={t(($) => $.app.dialogs.recovery.title)}
          message={t(
            modal.draft.baseRevision === modal.document.revision
              ? ($) => $.app.dialogs.recovery.messageCurrent
              : ($) => $.app.dialogs.recovery.messageChanged,
            {
              id: modal.document.id,
              savedAt: new Date(modal.draft.savedAtMs).toLocaleString(),
            },
          )}
          actions={[
            {
              label: t(($) => $.app.dialogs.recovery.useDisk),
              kind: "danger",
              onClick: keepDiskVersion,
            },
            {
              label: t(($) => $.app.dialogs.recovery.restore),
              kind: "primary",
              onClick: restoreRecoveryDraft,
            },
          ]}
        />
      )}
      {modal?.kind === "close" && (
        <Modal
          title={t(($) => $.app.dialogs.close.title)}
          message={t(($) => $.app.dialogs.close.message)}
          actions={[
            { label: t(($) => $.common.cancel), onClick: () => setModal(null) },
            {
              label: t(($) => $.app.dialogs.close.discardAndExit),
              kind: "danger",
              onClick: discardAndClose,
            },
            {
              label: t(($) => $.app.dialogs.close.saveAndExit),
              onClick: saveAndClose,
            },
          ]}
          onDismiss={() => setModal(null)}
        />
      )}
      {modal?.kind === "discard" && (
        <Modal
          title={t(($) => $.app.dialogs.discard.title)}
          message={t(($) => $.app.dialogs.discard.message)}
          actions={[
            { label: t(($) => $.common.cancel), onClick: () => setModal(null) },
            {
              label: t(($) => $.app.dialogs.discard.continue),
              kind: "danger",
              onClick: () => {
                const { postId, projectGeneration, next } = modal;
                setModal(null);
                void run(async () => {
                  await waitForPendingImages();
                  // 先确认磁盘文章仍可读取，避免清完图片后才发现无法恢复编辑会话。
                  const fresh = await api.readPost(projectGeneration, postId);
                  cancelScheduledDraft();
                  await waitForDraftQueue();
                  await api.discardPendingImages(projectGeneration, postId);
                  await enqueueDraftOperation(() =>
                    api.deleteDraft(projectGeneration, postId),
                  );
                  await loadSession(fresh, false);
                  await next(fresh);
                });
              },
            },
          ]}
          onDismiss={() => setModal(null)}
        />
      )}
      {modal?.kind === "delete" && (
        <Modal
          title={t(($) => $.app.dialogs.deletePost.title)}
          message={t(
            modal.hasUnsavedChanges
              ? ($) => $.app.dialogs.deletePost.messageWithUnsaved
              : ($) => $.app.dialogs.deletePost.message,
            { id: modal.id },
          )}
          actions={[
            { label: t(($) => $.common.cancel), onClick: () => setModal(null) },
            {
              label: t(($) => $.app.dialogs.deletePost.confirm),
              kind: "danger",
              onClick: confirmDeletePost,
            },
          ]}
          onDismiss={() => setModal(null)}
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
  const stem =
    id
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? id;
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
