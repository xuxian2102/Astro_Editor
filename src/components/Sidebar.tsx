import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PostSummary, ProjectInfo } from "../lib/tauriApi";

interface SidebarProps {
  project: ProjectInfo | null;
  posts: PostSummary[];
  activeId: string | null;
  onOpenProject: () => void;
  onOpenPost: (id: string) => void;
  onCreatePost: (name: string) => void;
  onRenamePost: (oldId: string, newName: string) => void;
  onDeletePost: (id: string) => void;
}

export default function Sidebar({
  project,
  posts,
  activeId,
  onOpenProject,
  onOpenPost,
  onCreatePost,
  onRenamePost,
  onDeletePost,
}: SidebarProps) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  useLayoutEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  const projectName = project ? basename(project.root) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button type="button" onClick={onOpenProject}>
          {projectName
            ? t(($) => $.sidebar.switchProject)
            : t(($) => $.sidebar.openProject)}
        </button>
        {projectName && (
          <span className="project-name" title={project?.root}>
            {projectName}
          </span>
        )}
      </div>

      {project && (
        <>
          <div className="sidebar-actions">
            {creating ? (
              <input
                ref={createInputRef}
                className="inline-input"
                value={newName}
                placeholder={t(($) => $.sidebar.fileNamePlaceholder)}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    onCreatePost(newName.trim());
                    setNewName("");
                    setCreating(false);
                  } else if (e.key === "Escape") {
                    setCreating(false);
                    setNewName("");
                  }
                }}
                onBlur={() =>
                  dismissInlineEditAfterBlur(() => setCreating(false))
                }
              />
            ) : (
              <button type="button" onClick={() => setCreating(true)}>
                {t(($) => $.sidebar.newPost)}
              </button>
            )}
          </div>

          <ul className="post-list">
            {posts.map((post) => (
              <li key={post.id}>
                {renamingId === post.id ? (
                  <input
                    ref={renameInputRef}
                    className="inline-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameValue.trim()) {
                        onRenamePost(post.id, renameValue.trim());
                        setRenamingId(null);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() =>
                      dismissInlineEditAfterBlur(() => setRenamingId(null))
                    }
                  />
                ) : (
                  <div
                    className={
                      post.id === activeId ? "post-item active" : "post-item"
                    }
                  >
                    <button
                      type="button"
                      className="post-open"
                      onClick={() => onOpenPost(post.id)}
                      title={post.relativePath}
                    >
                      {post.id}
                    </button>
                    {post.id === activeId && (
                      <>
                        <button
                          type="button"
                          className="post-rename"
                          title={t(($) => $.sidebar.rename)}
                          aria-label={t(($) => $.sidebar.renamePost, {
                            id: post.id,
                          })}
                          onClick={() => {
                            setRenamingId(post.id);
                            setRenameValue(post.id);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="post-delete"
                          title={t(($) => $.sidebar.moveToTrash)}
                          aria-label={t(($) => $.sidebar.deletePost, {
                            id: post.id,
                          })}
                          onClick={() => onDeletePost(post.id)}
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
            {posts.length === 0 && (
              <li className="post-empty">{t(($) => $.sidebar.noPosts)}</li>
            )}
          </ul>
        </>
      )}
    </aside>
  );
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 普通失焦结束行内编辑；若失焦是因为模态框打开，则保留输入和恢复焦点目标。 */
function dismissInlineEditAfterBlur(dismiss: () => void) {
  requestAnimationFrame(() => {
    const modalOpen = document.querySelector(
      '[role="dialog"][aria-modal="true"]',
    );
    if (!modalOpen) dismiss();
  });
}
