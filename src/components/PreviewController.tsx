import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type PreviewStatus } from "../lib/tauriApi";

interface PreviewControllerProps {
  projectGeneration: number;
  /** 当前打开文章的 PostId（未打开则 null）；预览会跳转到它对应的路由 */
  activePostId: string | null;
  /** 外部 Astro 只读磁盘，因此启动/导航前必须先通过保存屏障。 */
  beforePreview: () => Promise<boolean>;
}

export default function PreviewController({
  projectGeneration,
  activePostId,
  beforePreview,
}: PreviewControllerProps) {
  const [status, setStatus] = useState<PreviewStatus>({ phase: "stopped" });
  const [error, setError] = useState<string | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const activePostIdRef = useRef(activePostId);
  activePostIdRef.current = activePostId;
  const projectGenerationRef = useRef(projectGeneration);
  projectGenerationRef.current = projectGeneration;

  useEffect(() => {
    let disposed = false;
    // 必须先注册监听，再去同步一次当前状态——反过来的话，注册前发生的状态变化会被错过
    const unlistenPromise = listen<PreviewStatus>("preview://status", (event) => {
      if (!disposed) setStatus(event.payload);
    });
    api
      .getPreviewStatus()
      .then((s) => {
        if (!disposed) setStatus(s);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const run = async (action: () => Promise<PreviewStatus>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const start = () => {
    if (preparing) return;
    setPreparing(true);
    void (async () => {
      try {
        if (!(await beforePreview())) return;
        await run(() =>
          api.ensurePreviewServer(
            projectGenerationRef.current,
            activePostIdRef.current,
          ),
        );
      } finally {
        setPreparing(false);
      }
    })();
  };
  const stop = () => void run(() => api.stopPreviewServer());

  return (
    <div className="preview-controller">
      {error && <span className="preview-error" title={error}>⚠</span>}
      {status.phase === "stopped" && (
        <button type="button" onClick={start} disabled={preparing}>
          {preparing ? "正在保存…" : "预览"}
        </button>
      )}
      {status.phase === "starting" && (
        <>
          <span className="preview-spinner" aria-hidden />
          <span>正在启动 Astro…</span>
          <button type="button" onClick={stop}>
            取消
          </button>
        </>
      )}
      {status.phase === "ready" && (
        <>
          <button type="button" onClick={start} title={status.url} disabled={preparing}>
            {preparing ? "正在保存…" : "打开预览"}
          </button>
          <button type="button" onClick={() => void openUrl(status.url)}>
            在系统浏览器打开
          </button>
          <button type="button" onClick={stop}>
            停止
          </button>
        </>
      )}
      {status.phase === "stopping" && <span>正在停止预览…</span>}
      {status.phase === "failed" && (
        <div className="preview-failed">
          <span className="preview-error-text">{status.message}</span>
          <button type="button" onClick={start} disabled={preparing}>
            重试
          </button>
          {status.logTail && (
            <button type="button" onClick={() => setLogExpanded((v) => !v)}>
              {logExpanded ? "隐藏日志" : "查看日志"}
            </button>
          )}
          {logExpanded && status.logTail && (
            <pre className="preview-log">{status.logTail}</pre>
          )}
        </div>
      )}
    </div>
  );
}
