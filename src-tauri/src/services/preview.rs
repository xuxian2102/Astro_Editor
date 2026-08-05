use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

use crate::error::{code, AppError, ErrorPayload};
use crate::model::{PreviewStatus, ProjectContext};
use crate::services::posts;
use crate::state::AppState;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_INTERVAL: Duration = Duration::from_millis(300);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_millis(1500);
const LOG_TAIL_MAX_LEN: usize = 4000;

/// 预览服务生命周期状态；只存状态本身，不持有 Child——Child 由后台任务自己持有，
/// 且后台任务在 Ready 之后仍然存活（进入"存活阶段"看守取消信号/进程意外退出），
/// 不会在 Ready 之后就返回——否则没有任何东西再监听后续的取消请求。
/// generation 用于让过期的后台任务能识别自己已经被取代，从而放弃写回状态。
#[derive(Default)]
pub struct PreviewManager {
    generation: u64,
    status: PreviewStatus,
    cancellation: Option<CancellationToken>,
    project_root: Option<PathBuf>,
}

// ---- 纯函数 / 不依赖 AppHandle 的核心逻辑：直接单测 ----

/// 按 Astro 5 Content Collections `glob()` loader 的默认规则，把文件路径转成 Entry ID：
/// 去掉最终扩展名、逐段使用 GitHub slugger，并把嵌套目录中的 `/index` 归约到目录本身。
pub fn resolve_slug(post_id: &str) -> String {
    let last_slash = post_id.rfind('/').map(|i| i + 1).unwrap_or(0);
    let without_extension = match post_id[last_slash..].rfind('.') {
        Some(rel_idx) => &post_id[..last_slash + rel_idx],
        None => post_id,
    };
    let mut slug = without_extension
        .split('/')
        .map(github_slugger::slug)
        .collect::<Vec<_>>()
        .join("/");
    if let Some(parent) = slug.strip_suffix("/index") {
        slug = parent.to_owned();
    }
    slug
}

pub fn resolve_route(template: &str, slug: &str) -> String {
    template.replace("{slug}", slug)
}

pub fn resolve_executable(root: &Path, command: &str) -> Result<PathBuf, AppError> {
    let path = root.join(command);
    let canonical = path.canonicalize().map_err(|_| {
        AppError::Preview(format!(
            "找不到预览命令：{}（请先在项目里执行 pnpm install / npm install）",
            path.display()
        ))
    })?;
    if !canonical.is_file() || !canonical.starts_with(root) {
        return Err(AppError::Preview(format!(
            "预览命令必须解析到项目目录内的文件：{}",
            path.display()
        )));
    }
    Ok(canonical)
}

/// 核对 generation 后再写状态；不一致说明是过期的后台任务，直接丢弃
fn try_apply(manager: &mut PreviewManager, generation: u64, status: PreviewStatus) -> bool {
    if manager.generation != generation {
        return false;
    }
    let terminal = matches!(
        status,
        PreviewStatus::Stopped | PreviewStatus::Failed { .. }
    );
    manager.status = status;
    if terminal {
        manager.cancellation = None;
    }
    true
}

fn frontmatter_slug(ctx: &ProjectContext, post_id: &str) -> Result<Option<String>, AppError> {
    let document = posts::read_post(ctx, post_id)?;
    let Some(raw_frontmatter) = document.raw_frontmatter else {
        return Ok(None);
    };
    // Astro 的 glob loader 在默认 ID 生成前会优先采用 data.slug。解析失败留给 Astro
    // 自己报告正文错误，这里退回文件名规则，避免预览按钮制造第二套 YAML 报错。
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&raw_frontmatter) else {
        return Ok(None);
    };
    Ok(value
        .get("slug")
        .and_then(serde_yaml::Value::as_str)
        .filter(|slug| !slug.is_empty())
        .map(str::to_owned))
}

fn compute_target_path(ctx: &ProjectContext, post_id: Option<&str>) -> Result<String, AppError> {
    match (&ctx.config.preview.route_template, post_id) {
        (Some(template), Some(id)) => {
            let slug = frontmatter_slug(ctx, id)?.unwrap_or_else(|| resolve_slug(id));
            Ok(resolve_route(template, &slug))
        }
        _ => Ok("/".to_string()),
    }
}

fn base_url(ctx: &ProjectContext) -> String {
    format!(
        "http://{}:{}",
        ctx.config.preview.host, ctx.config.preview.port
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 极简手写 HTTP 探测：只关心"有没有收到一个像样的 HTTP 响应"，不需要真正的 HTTP 客户端
async fn probe_ready(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    let Ok(Ok(mut stream)) =
        tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(&addr)).await
    else {
        return false;
    };
    let req = format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).await.is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    match tokio::time::timeout(Duration::from_millis(400), stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => buf[..n].starts_with(b"HTTP/1."),
        _ => false,
    }
}

async fn port_is_available(host: &str, port: u16) -> bool {
    TcpListener::bind((host, port)).await.is_ok()
}

async fn terminate_process_group(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        let _ = child.kill().await;
        return;
    };
    // SAFETY: 只是发信号给自己 spawn 的进程组（process_group(0) 让子进程 pid == pgid），不涉及内存操作
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
    }
    if tokio::time::timeout(GRACEFUL_STOP_TIMEOUT, child.wait())
        .await
        .is_err()
    {
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
}

fn spawn_drain(
    pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    buf: Arc<TokioMutex<String>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(pipe);
        let mut chunk = [0u8; 1024];
        while let Ok(size) = reader.read(&mut chunk).await {
            if size == 0 {
                break;
            }
            let mut guard = buf.lock().await;
            guard.push_str(&String::from_utf8_lossy(&chunk[..size]));
            if guard.len() > LOG_TAIL_MAX_LEN {
                let mut start = guard.len() - LOG_TAIL_MAX_LEN;
                while !guard.is_char_boundary(start) {
                    start += 1;
                }
                guard.drain(..start);
            }
        }
    })
}

/// 只负责"用给定参数起一个进程"，不知道 astro 的 --host/--port 约定——
/// 那是调用方（run_preview_lifecycle）的事，这样这个函数才能用任意命令单测
fn build_command(exe: &Path, cwd: &Path, args: &[String]) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(exe);
    command
        .current_dir(cwd)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        // 兜底：万一显式清理路径没跑到（比如运行时被直接丢弃），至少杀掉进程本身
        .kill_on_drop(true);
    command
}

/// 启动阶段的结局。不含 AppHandle/窗口/事件——只关心进程和网络，可以直接用真实子进程单测。
#[derive(Debug)]
enum StartupOutcome {
    /// 探测到服务已就绪；child 仍然存活，调用方决定后续怎么处理
    Ready,
    Cancelled,
    ExitedEarly(std::io::Result<std::process::ExitStatus>),
    TimedOut,
    SpawnFailed(String),
}

/// spawn 子进程并轮询就绪，直到就绪/取消/提前退出/超时。
/// 不做任何 Tauri 相关的事情（窗口、事件、状态锁），方便直接用真实进程单测。
async fn run_startup(
    exe: &Path,
    cwd: &Path,
    args: &[String],
    host: &str,
    port: u16,
    cancel_token: &CancellationToken,
    startup_timeout: Duration,
) -> (
    StartupOutcome,
    Option<tokio::process::Child>,
    Arc<TokioMutex<String>>,
) {
    let log_tail: Arc<TokioMutex<String>> = Arc::new(TokioMutex::new(String::new()));

    let mut child = match build_command(exe, cwd, args).spawn() {
        Ok(child) => child,
        Err(e) => return (StartupOutcome::SpawnFailed(e.to_string()), None, log_tail),
    };

    let mut drain_tasks = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        drain_tasks.push(spawn_drain(stdout, log_tail.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        drain_tasks.push(spawn_drain(stderr, log_tail.clone()));
    }

    let deadline = tokio::time::sleep(startup_timeout);
    tokio::pin!(deadline);
    let mut probe = tokio::time::interval(PROBE_INTERVAL);

    let outcome = loop {
        tokio::select! {
            _ = cancel_token.cancelled() => break StartupOutcome::Cancelled,
            exit = child.wait() => break StartupOutcome::ExitedEarly(exit),
            _ = &mut deadline => break StartupOutcome::TimedOut,
            _ = probe.tick() => {
                if probe_ready(host, port).await {
                    match child.try_wait() {
                        Ok(None) => break StartupOutcome::Ready,
                        Ok(Some(status)) => break StartupOutcome::ExitedEarly(Ok(status)),
                        Err(error) => break StartupOutcome::ExitedEarly(Err(error)),
                    }
                }
            }
        }
    };

    // wait/try_wait 只说明进程结束，不保证独立的 stdout/stderr drain task 已经读到 EOF。
    // 提前退出时先短暂等它们收尾，避免丢掉最关键的启动错误；若后代仍持有 pipe，
    // 超时后让 task 继续后台退出，不能卡住预览状态机。
    if matches!(&outcome, StartupOutcome::ExitedEarly(_)) {
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            for task in drain_tasks {
                let _ = task.await;
            }
        })
        .await;
    }

    (outcome, Some(child), log_tail)
}

/// 存活阶段的结局：Ready 之后一直待在这里看守，直到取消或进程自己退出
enum SteadyOutcome {
    Cancelled,
    ExitedUnexpectedly(std::io::Result<std::process::ExitStatus>),
}

async fn run_steady(
    child: &mut tokio::process::Child,
    cancel_token: &CancellationToken,
) -> SteadyOutcome {
    tokio::select! {
        _ = cancel_token.cancelled() => SteadyOutcome::Cancelled,
        exit = child.wait() => SteadyOutcome::ExitedUnexpectedly(exit),
    }
}

// ---- 对外入口 ----

/// 确保预览服务在跑：已经就绪则只把窗口跳转到新目标；正在启动/停止则原样返回当前状态；
/// 否则发起新一轮启动，立即返回 Starting，真正的 spawn+就绪探测在后台任务里进行。
pub async fn ensure(
    app: AppHandle,
    ctx: ProjectContext,
    post_id: Option<String>,
) -> Result<PreviewStatus, AppError> {
    let state = app.state::<AppState>();
    let target_path = compute_target_path(&ctx, post_id.as_deref())?;

    let (generation, token, status) = {
        let mut manager = state.preview.lock().await;
        let same_project = manager.project_root.as_deref() == Some(ctx.root.as_path());

        if same_project {
            match manager.status.clone() {
                PreviewStatus::Ready {
                    generation, pid, ..
                } => {
                    let full_url = format!("{}{}", base_url(&ctx), target_path);
                    let status = PreviewStatus::Ready {
                        generation,
                        url: full_url.clone(),
                        pid,
                    };
                    manager.status = status.clone();
                    drop(manager);
                    emit_status(&app, &status);
                    navigate_preview_window(&app, &full_url)?;
                    return Ok(status);
                }
                PreviewStatus::Starting { .. } | PreviewStatus::Stopping { .. } => {
                    return Ok(manager.status.clone());
                }
                _ => {}
            }
        }

        // 到这里：Stopped/Failed，或者是切换到了不同项目——残留的旧一轮先取消掉
        if let Some(old_token) = manager.cancellation.take() {
            old_token.cancel();
        }

        manager.generation += 1;
        let generation = manager.generation;
        manager.project_root = Some(ctx.root.clone());
        let token = CancellationToken::new();
        manager.cancellation = Some(token.clone());
        let status = PreviewStatus::Starting {
            generation,
            started_at_ms: now_ms(),
        };
        manager.status = status.clone();

        (generation, token, status)
    };

    emit_status(&app, &status);

    let app_for_task = app.clone();
    tokio::spawn(async move {
        run_preview_lifecycle(app_for_task, ctx, generation, token, target_path).await;
    });

    Ok(status)
}

/// 请求停止：运行中的生命周期改成 Stopping、发出取消信号并立刻返回；Failed 已经没有
/// 子进程可等，直接清回 Stopped，避免配置保存后永久卡在“正在停止预览”。
pub async fn stop(app: &AppHandle) -> Result<PreviewStatus, AppError> {
    let state = app.state::<AppState>();
    let mut manager = state.preview.lock().await;
    let status = match &manager.status {
        PreviewStatus::Stopped => return Ok(PreviewStatus::Stopped),
        PreviewStatus::Stopping { .. } => manager.status.clone(),
        PreviewStatus::Failed { .. } => {
            manager.status = PreviewStatus::Stopped;
            PreviewStatus::Stopped
        }
        _ => {
            let generation = manager.generation;
            let status = PreviewStatus::Stopping { generation };
            manager.status = status.clone();
            if let Some(token) = &manager.cancellation {
                token.cancel();
            }
            status
        }
    };
    drop(manager);
    emit_status(app, &status);
    Ok(status)
}

/// 项目切换必须等旧进程组真正退出，不能只发取消信号后立刻启动新项目。
pub async fn stop_and_wait(app: &AppHandle) -> Result<PreviewStatus, AppError> {
    let initial = stop(app).await?;
    if !matches!(initial, PreviewStatus::Stopping { .. }) {
        return Ok(initial);
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        let status = current_status(app).await;
        if matches!(
            status,
            PreviewStatus::Stopped | PreviewStatus::Failed { .. }
        ) {
            return Ok(status);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Preview(
                "等待旧预览进程退出超时，请停止占用的 Astro 进程后重试".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn current_status(app: &AppHandle) -> PreviewStatus {
    let state = app.state::<AppState>();
    let status = state.preview.lock().await.status.clone();
    status
}

/// 应用退出时的最后防线：尽力而为地杀掉还在跑的预览进程组，不等待也不走完整的
/// 异步收尾流程（进程马上要随应用一起消失了，没必要）。正常路径已经在项目切换/
/// 主动停止时处理过，这里只兜底 Ready 状态下应用被直接关闭的情况。
pub fn best_effort_kill_on_exit(state: &AppState) {
    let Ok(manager) = state.preview.try_lock() else {
        return;
    };
    if let PreviewStatus::Ready { pid, .. } = &manager.status {
        unsafe {
            libc::kill(-(*pid as libc::pid_t), libc::SIGTERM);
        }
    }
}

fn emit_status(app: &AppHandle, status: &PreviewStatus) {
    use tauri::Emitter;
    // 只发主窗口；preview 窗口本来就没有能力监听任何事件，这里是双重保险
    if let Err(e) = app.emit_to("main", "preview://status", status) {
        log::warn!("推送预览状态事件失败：{e}");
    }
}

async fn finish(app: &AppHandle, generation: u64, status: PreviewStatus) -> bool {
    let state = app.state::<AppState>();
    let applied = {
        let mut manager = state.preview.lock().await;
        try_apply(&mut manager, generation, status.clone())
    };
    if applied {
        emit_status(app, &status);
    }
    applied
}

fn navigate_preview_window(app: &AppHandle, url: &str) -> Result<(), AppError> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| AppError::Preview(format!("URL 无效：{e}")))?;
    if let Some(window) = app.get_webview_window("preview") {
        window
            .navigate(parsed)
            .map_err(|e| AppError::Preview(e.to_string()))?;
        let _ = window.set_focus();
    } else {
        tauri::WebviewWindowBuilder::new(app, "preview", tauri::WebviewUrl::External(parsed))
            .title("预览")
            .inner_size(1024.0, 800.0)
            .build()
            .map_err(|e| AppError::Preview(e.to_string()))?;
    }
    Ok(())
}

fn close_preview_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("preview") {
        let _ = window.close();
    }
}

/// 后台任务全流程：解析可执行文件 → 启动阶段（spawn+就绪探测）→ 存活阶段
/// （Ready 之后继续看守，直到取消或进程自己退出）。每次状态回写前都要经过
/// try_apply 的 generation 核对，过期的这一轮只负责清理自己的子进程，不改共享状态。
async fn run_preview_lifecycle(
    app: AppHandle,
    ctx: ProjectContext,
    generation: u64,
    cancel_token: CancellationToken,
    target_path: String,
) {
    let exe = match resolve_executable(&ctx.root, &ctx.config.preview.command) {
        Ok(exe) => exe,
        Err(e) => {
            finish(
                &app,
                generation,
                PreviewStatus::Failed {
                    generation,
                    error: e.payload(),
                    log_tail: String::new(),
                },
            )
            .await;
            return;
        }
    };

    if !port_is_available(&ctx.config.preview.host, ctx.config.preview.port).await {
        let port = ctx.config.preview.port;
        finish(
            &app,
            generation,
            PreviewStatus::Failed {
                generation,
                error: ErrorPayload::new(
                    code::PREVIEW_PORT_IN_USE,
                    format!("预览端口 {port} 已被占用，请停止占用进程或在项目设置中更换端口"),
                )
                .with_param("port", port),
                log_tail: String::new(),
            },
        )
        .await;
        return;
    }

    // astro dev 的 --host/--port 约定只有这里知道，run_startup 本身对命令行参数不做假设
    let mut args = ctx.config.preview.args.clone();
    args.push("--host".into());
    args.push(ctx.config.preview.host.clone());
    args.push("--port".into());
    args.push(ctx.config.preview.port.to_string());

    let (outcome, child, log_tail) = run_startup(
        &exe,
        &ctx.root,
        &args,
        &ctx.config.preview.host,
        ctx.config.preview.port,
        &cancel_token,
        STARTUP_TIMEOUT,
    )
    .await;

    match outcome {
        StartupOutcome::SpawnFailed(detail) => {
            finish(
                &app,
                generation,
                PreviewStatus::Failed {
                    generation,
                    error: ErrorPayload::new(
                        code::PREVIEW_SPAWN_FAILED,
                        format!("无法启动预览：{detail}"),
                    )
                    .with_param("detail", detail),
                    log_tail: String::new(),
                },
            )
            .await;
        }
        StartupOutcome::Cancelled => {
            if let Some(mut child) = child {
                terminate_process_group(&mut child).await;
            }
            finish(&app, generation, PreviewStatus::Stopped).await;
        }
        StartupOutcome::ExitedEarly(exit) => {
            let exit = format!("{exit:?}");
            let tail = log_tail.lock().await.clone();
            finish(
                &app,
                generation,
                PreviewStatus::Failed {
                    generation,
                    error: ErrorPayload::new(
                        code::PREVIEW_EXITED_EARLY,
                        format!("预览进程提前退出（{exit}）"),
                    )
                    .with_param("exit", exit),
                    log_tail: tail,
                },
            )
            .await;
        }
        StartupOutcome::TimedOut => {
            if let Some(mut child) = child {
                terminate_process_group(&mut child).await;
            }
            let tail = log_tail.lock().await.clone();
            let seconds = STARTUP_TIMEOUT.as_secs();
            finish(
                &app,
                generation,
                PreviewStatus::Failed {
                    generation,
                    error: ErrorPayload::new(
                        code::PREVIEW_STARTUP_TIMEOUT,
                        format!("启动超时（{seconds} 秒内未就绪）"),
                    )
                    .with_param("seconds", seconds),
                    log_tail: tail,
                },
            )
            .await;
        }
        StartupOutcome::Ready => {
            let Some(mut child) = child else { return };
            let pid = child.id().unwrap_or(0);
            let url = format!("{}{}", base_url(&ctx), target_path);
            let applied = finish(
                &app,
                generation,
                PreviewStatus::Ready {
                    generation,
                    url: url.clone(),
                    pid,
                },
            )
            .await;
            if !applied {
                // 已经被更晚一轮的启动/停止取代，这个进程不再需要
                terminate_process_group(&mut child).await;
                return;
            }
            if let Err(e) = navigate_preview_window(&app, &url) {
                log::warn!("打开预览窗口失败：{e}");
            }

            // 存活阶段：Ready 之后继续待在这里，直到取消或进程自己退出
            match run_steady(&mut child, &cancel_token).await {
                SteadyOutcome::Cancelled => {
                    terminate_process_group(&mut child).await;
                    if finish(&app, generation, PreviewStatus::Stopped).await {
                        close_preview_window(&app);
                    }
                }
                SteadyOutcome::ExitedUnexpectedly(exit) => {
                    let exit = format!("{exit:?}");
                    let tail = log_tail.lock().await.clone();
                    if finish(
                        &app,
                        generation,
                        PreviewStatus::Failed {
                            generation,
                            error: ErrorPayload::new(
                                code::PREVIEW_EXITED_UNEXPECTEDLY,
                                format!("预览进程意外退出（{exit}）"),
                            )
                            .with_param("exit", exit),
                            log_tail: tail,
                        },
                    )
                    .await
                    {
                        close_preview_window(&app);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProjectConfig;
    use std::path::PathBuf;

    #[test]
    fn resolve_slug_matches_astro_default_content_id_rules() {
        assert_eq!(resolve_slug("hello-astro.md"), "hello-astro");
        assert_eq!(resolve_slug("nested/2026-plans.md"), "nested/2026-plans");
        assert_eq!(resolve_slug("Photo_test.md"), "photo_test");
        assert_eq!(resolve_slug("Nested/My Post!.md"), "nested/my-post");
        assert_eq!(resolve_slug("Nested/index.md"), "nested");
        assert_eq!(resolve_slug("no-extension"), "no-extension");
        assert_eq!(resolve_slug("a.b/c"), "ab/c");
        assert_eq!(resolve_slug("a.b/c.md"), "ab/c");
    }

    #[test]
    fn compute_target_path_honors_default_and_frontmatter_slugs() {
        let dir = tempfile::tempdir().unwrap();
        let content_root = dir.path().canonicalize().unwrap();
        let mut config = ProjectConfig::default();
        config.preview.route_template = Some("/blog/{slug}".into());
        let ctx = ProjectContext {
            root: content_root.clone(),
            content_root: content_root.clone(),
            config,
        };

        std::fs::write(
            content_root.join("Photo_test.md"),
            "---\ntitle: Photo\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(
            content_root.join("custom.md"),
            "---\ntitle: Custom\nslug: Kept/Exactly\n---\nbody\n",
        )
        .unwrap();

        assert_eq!(
            compute_target_path(&ctx, Some("Photo_test.md")).unwrap(),
            "/blog/photo_test"
        );
        assert_eq!(
            compute_target_path(&ctx, Some("custom.md")).unwrap(),
            "/blog/Kept/Exactly"
        );
    }

    #[test]
    fn resolve_route_substitutes_slug() {
        assert_eq!(
            resolve_route("/blog/{slug}", "hello-astro"),
            "/blog/hello-astro"
        );
        assert_eq!(resolve_route("/{slug}/", "a"), "/a/");
        assert_eq!(resolve_route("/blog", "a"), "/blog");
    }

    #[test]
    fn resolve_executable_reports_missing_command() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_executable(dir.path(), "node_modules/.bin/astro").unwrap_err();
        assert!(matches!(err, AppError::Preview(_)));

        let bin = dir.path().join("fake-astro");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert!(resolve_executable(dir.path(), "fake-astro").is_ok());
    }

    fn manager_with(generation: u64, status: PreviewStatus) -> PreviewManager {
        PreviewManager {
            generation,
            status,
            cancellation: None,
            project_root: None,
        }
    }

    #[test]
    fn try_apply_rejects_stale_generation() {
        let mut manager = manager_with(
            2,
            PreviewStatus::Starting {
                generation: 2,
                started_at_ms: 0,
            },
        );
        let applied = try_apply(
            &mut manager,
            1,
            PreviewStatus::Ready {
                generation: 1,
                url: "http://x".into(),
                pid: 1,
            },
        );
        assert!(!applied);
        assert!(matches!(
            manager.status,
            PreviewStatus::Starting { generation: 2, .. }
        ));
    }

    #[test]
    fn try_apply_accepts_current_generation_and_clears_token_on_terminal_state() {
        let mut manager = manager_with(
            3,
            PreviewStatus::Starting {
                generation: 3,
                started_at_ms: 0,
            },
        );
        manager.cancellation = Some(CancellationToken::new());

        let applied = try_apply(
            &mut manager,
            3,
            PreviewStatus::Ready {
                generation: 3,
                url: "http://x".into(),
                pid: 42,
            },
        );
        assert!(applied);
        assert!(manager.cancellation.is_some());

        let applied = try_apply(&mut manager, 3, PreviewStatus::Stopped);
        assert!(applied);
        assert!(manager.cancellation.is_none());
    }

    // ---- 真实子进程集成测试：不需要 AppHandle，直接测 run_startup/run_steady/terminate_process_group ----

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    fn sh() -> PathBuf {
        PathBuf::from("/bin/sh")
    }

    /// `kill(pid, 0)` 对 zombie 仍返回成功。容器里的 PID 1 可能不会立即回收孤儿
    /// zombie，因此用 /proc 状态判断“是否还在运行”，而不是判断 PID 表项是否存在。
    fn process_is_running(pid: libc::pid_t) -> bool {
        let stat = match std::fs::read(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return unsafe { libc::kill(pid, 0) } == 0,
        };
        let state = stat
            .windows(2)
            .rposition(|window| window == b") ")
            .and_then(|end| stat.get(end + 2).copied());
        !matches!(state, Some(b'Z') | Some(b'X'))
    }

    #[tokio::test]
    async fn run_startup_reaches_ready_when_server_responds() {
        let port = free_port();
        // 用 python3 http.server 当"假 astro dev"：不需要真的装 astro 也能验证探测逻辑
        let (outcome, child, _log) = run_startup(
            &PathBuf::from("python3"),
            Path::new("/tmp"),
            &[
                "-m".into(),
                "http.server".into(),
                "--bind".into(),
                "127.0.0.1".into(),
                port.to_string(),
            ],
            "127.0.0.1",
            port,
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await;

        assert!(matches!(outcome, StartupOutcome::Ready), "{outcome:?}");
        let mut child = child.expect("Ready 时应当带回 child");
        terminate_process_group(&mut child).await;
    }

    #[tokio::test]
    async fn run_startup_reports_spawn_failure_for_missing_command() {
        let (outcome, child, _log) = run_startup(
            Path::new("/definitely/not/a/real/command"),
            Path::new("/tmp"),
            &[],
            "127.0.0.1",
            free_port(),
            &CancellationToken::new(),
            Duration::from_secs(2),
        )
        .await;

        assert!(matches!(outcome, StartupOutcome::SpawnFailed(_)));
        assert!(child.is_none());
    }

    #[tokio::test]
    async fn run_startup_detects_process_exiting_early() {
        let (outcome, _child, log) = run_startup(
            &sh(),
            Path::new("/tmp"),
            &["-c".into(), "echo boom >&2; exit 1".into()],
            "127.0.0.1",
            free_port(),
            &CancellationToken::new(),
            Duration::from_secs(5),
        )
        .await;

        assert!(matches!(outcome, StartupOutcome::ExitedEarly(_)));
        let tail = log.lock().await.clone();
        assert!(tail.contains("boom"));
    }

    #[tokio::test]
    async fn run_startup_times_out_when_nothing_ever_listens() {
        let (outcome, child, _log) = run_startup(
            &sh(),
            Path::new("/tmp"),
            &["-c".into(), "sleep 30".into()],
            "127.0.0.1",
            free_port(),
            &CancellationToken::new(),
            Duration::from_millis(500),
        )
        .await;

        assert!(matches!(outcome, StartupOutcome::TimedOut));
        drop(child); // kill_on_drop 兜底清理
    }

    #[tokio::test]
    async fn run_startup_stops_on_cancellation() {
        let token = CancellationToken::new();
        let token_clone = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token_clone.cancel();
        });

        let (outcome, child, _log) = run_startup(
            &sh(),
            Path::new("/tmp"),
            &["-c".into(), "sleep 30".into()],
            "127.0.0.1",
            free_port(),
            &token,
            Duration::from_secs(10),
        )
        .await;

        assert!(matches!(outcome, StartupOutcome::Cancelled));
        drop(child);
    }

    /// 验证"避免 npm/pnpm 包一层导致杀不干净"：sh -c 起一个孙进程（sleep），
    /// 杀掉整个进程组后，父子两代都必须真的消失，不能只杀了 sh 本身。
    /// 孙进程 pid 通过子进程自己的 stdout 传回来，避免用共享文件路径（并发测试会互相踩）。
    #[tokio::test]
    async fn terminate_process_group_kills_grandchildren_too() {
        let mut child = tokio::process::Command::new(sh())
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();

        let stdout = child.stdout.take().unwrap();
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line),
        )
        .await
        .expect("等孙进程 pid 超时")
        .unwrap();
        let grandchild_pid: libc::pid_t = line.trim().parse().expect("孙进程应打印自己的 pid");

        // 杀之前孙进程应该还活着
        assert!(process_is_running(grandchild_pid), "杀之前孙进程应该还活着");

        terminate_process_group(&mut child).await;

        // terminate_process_group 只同步等待直接子进程（sh）被回收；sleep 是 sh 的子进程，
        // 不是我们的子进程，我们没法对它 waitpid，只能发信号后等它自己在内核调度下退出——
        // 这通常是毫秒级的，允许短暂轮询而不是要求 kill 一返回就已经消失
        let mut still_alive = true;
        for _ in 0..20 {
            if !process_is_running(grandchild_pid) {
                still_alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !still_alive,
            "进程组被杀之后，孙进程也必须在短时间内一起消失"
        );
    }

    #[tokio::test]
    async fn run_steady_reacts_to_cancellation_and_early_exit() {
        let mut child = tokio::process::Command::new(sh())
            .arg("-c")
            .arg("sleep 30")
            .spawn()
            .unwrap();
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            run_steady(&mut child, &token).await,
            SteadyOutcome::Cancelled
        ));
        let _ = child.kill().await;

        let mut child = tokio::process::Command::new(sh())
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .unwrap();
        assert!(matches!(
            run_steady(&mut child, &CancellationToken::new()).await,
            SteadyOutcome::ExitedUnexpectedly(_)
        ));
    }
}
