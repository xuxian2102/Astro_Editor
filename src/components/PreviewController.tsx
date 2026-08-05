import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
    const unlistenPromise = listen<PreviewStatus>(
      "preview://status",
      (event) => {
        if (!disposed) setStatus(event.payload);
      },
    );
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
      {error && (
        <span className="preview-error" title={error}>
          ⚠
        </span>
      )}
      {status.phase === "stopped" && (
        <button type="button" onClick={start} disabled={preparing}>
          {preparing ? t(($) => $.preview.saving) : t(($) => $.preview.preview)}
        </button>
      )}
      {status.phase === "starting" && (
        <>
          <span className="preview-spinner" aria-hidden />
          <span>{t(($) => $.preview.starting)}</span>
          <button type="button" onClick={stop}>
            {t(($) => $.common.cancel)}
          </button>
        </>
      )}
      {status.phase === "ready" && (
        <>
          <button
            type="button"
            onClick={start}
            title={status.url}
            disabled={preparing}
          >
            {preparing ? t(($) => $.preview.saving) : t(($) => $.preview.open)}
          </button>
          <button type="button" onClick={() => void openUrl(status.url)}>
            {t(($) => $.preview.openInBrowser)}
          </button>
          <button type="button" onClick={stop}>
            {t(($) => $.preview.stop)}
          </button>
        </>
      )}
      {status.phase === "stopping" && (
        <span>{t(($) => $.preview.stopping)}</span>
      )}
      {status.phase === "failed" && (
        <div className="preview-failed">
          <span className="preview-error-text">
            {errorMessage(status.error)}
          </span>
          <button type="button" onClick={start} disabled={preparing}>
            {t(($) => $.preview.retry)}
          </button>
          {status.logTail && (
            <button type="button" onClick={() => setLogExpanded((v) => !v)}>
              {logExpanded
                ? t(($) => $.preview.hideLog)
                : t(($) => $.preview.showLog)}
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
