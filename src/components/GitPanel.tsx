import { useState } from "react";
import type { FileChange, GitStatus, PublishResult } from "../lib/tauriApi";
import { canPublish, changeLabel, groupChanges } from "../domain/gitStatus";

interface GitPanelProps {
  status: GitStatus | null;
  /** git_status 报错时的友好信息（比如"不是 git 仓库"），null 表示没有错误 */
  statusError: string | null;
  publishing: boolean;
  lastResult: PublishResult | null;
  onPublish: (message: string, push: boolean) => void;
  onRefresh: () => void;
}

export default function GitPanel({
  status,
  statusError,
  publishing,
  lastResult,
  onPublish,
  onRefresh,
}: GitPanelProps) {
  const [message, setMessage] = useState("");

  if (statusError) {
    return (
      <section className="git-panel">
        <div className="git-panel-header">
          <h2>Git</h2>
          <button type="button" onClick={onRefresh} title="刷新">
            ↻
          </button>
        </div>
        <p className="git-hint">{statusError}</p>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="git-panel">
        <div className="git-panel-header">
          <h2>Git</h2>
        </div>
        <p className="git-hint">加载中…</p>
      </section>
    );
  }

  const { managed, other } = groupChanges(status);
  const ready = canPublish(status) && message.trim().length > 0 && !publishing;

  const submit = (push: boolean) => {
    if (!ready) return;
    onPublish(message.trim(), push);
  };

  return (
    <section className="git-panel">
      <div className="git-panel-header">
        <h2>Git</h2>
        <button type="button" onClick={onRefresh} title="刷新">
          ↻
        </button>
      </div>

      <div className="git-branch-line">
        <span>{status.branch ?? "(游离 HEAD)"}</span>
        {status.upstream && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
      </div>

      <ChangeGroup title="编辑器管理（会被提交）" changes={managed} />
      <ChangeGroup title="仓库里其他改动（不会被提交）" changes={other} muted />

      <textarea
        className="git-message"
        placeholder="提交信息"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
      />

      <div className="git-actions">
        <button type="button" disabled={!ready} onClick={() => submit(false)}>
          提交
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!ready}
          onClick={() => submit(true)}
        >
          {publishing ? "发布中…" : "提交并推送"}
        </button>
      </div>

      {lastResult && <PublishResultCard result={lastResult} />}
    </section>
  );
}

function ChangeGroup({
  title,
  changes,
  muted,
}: {
  title: string;
  changes: FileChange[];
  muted?: boolean;
}) {
  if (changes.length === 0) return null;
  return (
    <div className={muted ? "git-group git-group-muted" : "git-group"}>
      <h3>{title}</h3>
      <ul>
        {changes.map((c) => (
          <li key={c.path}>
            <span className="git-change-kind">{changeLabel(c.kind)}</span>
            <span className="git-change-path" title={c.path}>
              {c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublishResultCard({ result }: { result: PublishResult }) {
  const ok = result.errorStage === null;
  return (
    <div className={ok ? "publish-result publish-ok" : "publish-result publish-partial"}>
      <div className="publish-steps">
        <Step label="暂存" done={result.staged} failed={result.errorStage === "stage"} />
        <Step label="提交" done={result.committed} failed={result.errorStage === "commit"} />
        <Step label="推送" done={result.pushed} failed={result.errorStage === "push"} skipped={!result.committed} />
      </div>
      {result.commitHash && (
        <p className="publish-hash">已提交 {result.commitHash.slice(0, 7)}</p>
      )}
      {result.message && <p className="publish-message">{result.message}</p>}
    </div>
  );
}

function Step({
  label,
  done,
  failed,
  skipped,
}: {
  label: string;
  done: boolean;
  failed: boolean;
  skipped?: boolean;
}) {
  const state = failed ? "failed" : done ? "done" : skipped ? "skipped" : "pending";
  return <span className={`publish-step publish-step-${state}`}>{label}</span>;
}
