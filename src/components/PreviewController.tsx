import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type PreviewStatus } from "../lib/tauriApi";

interface PreviewControllerProps {
  /** 当前打开文章的 PostId（未打开则 null）；预览会跳转到它对应的路由 */
  activePostId: string | null;
}

export default function PreviewController({ activePostId }: PreviewControllerProps) {
  const [status, setStatus] = useState<PreviewStatus>({ phase: "stopped" });
  const [error, setError] = useState<string | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const activePostIdRef = useRef(activePostId);
  activePostIdRef.current = activePostId;

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

  const run = (action: () => Promise<PreviewStatus>) => {
    setError(null);
    action().catch((e) => setError(errorMessage(e)));
  };

  const start = () => run(() => api.ensurePreviewServer(activePostIdRef.current));
  const stop = () => run(() => api.stopPreviewServer());

  return (
    <div className="preview-controller">
      {error && <span className="preview-error" title={error}>⚠</span>}
      {status.phase === "stopped" && (
        <button type="button" onClick={start}>
          预览
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
          <button type="button" onClick={start} title={status.url}>
            打开预览
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
          <button type="button" onClick={start}>
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
