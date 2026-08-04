import { useState } from "react";
import type { PostSummary, ProjectInfo } from "../lib/tauriApi";

interface SidebarProps {
  project: ProjectInfo | null;
  posts: PostSummary[];
  activeId: string | null;
  onOpenProject: () => void;
  onOpenPost: (id: string) => void;
  onCreatePost: (name: string) => void;
  onRenamePost: (oldId: string, newName: string) => void;
}

export default function Sidebar({
  project,
  posts,
  activeId,
  onOpenProject,
  onOpenPost,
  onCreatePost,
  onRenamePost,
}: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const projectName = project ? basename(project.root) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button type="button" onClick={onOpenProject}>
          {projectName ? "切换项目" : "打开项目"}
        </button>
        {projectName && <span className="project-name" title={project?.root}>{projectName}</span>}
      </div>

      {project && (
        <>
          <div className="sidebar-actions">
            {creating ? (
              <input
                autoFocus
                className="inline-input"
                value={newName}
                placeholder="文件名，如 my-post.md"
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
                onBlur={() => setCreating(false)}
              />
            ) : (
              <button type="button" onClick={() => setCreating(true)}>
                ＋ 新建文章
              </button>
            )}
          </div>

          <ul className="post-list">
            {posts.map((post) => (
              <li key={post.id}>
                {renamingId === post.id ? (
                  <input
                    autoFocus
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
                    onBlur={() => setRenamingId(null)}
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
                      <button
                        type="button"
                        className="post-rename"
                        title="重命名"
                        onClick={() => {
                          setRenamingId(post.id);
                          setRenameValue(post.id);
                        }}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {posts.length === 0 && <li className="post-empty">没有文章</li>}
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
