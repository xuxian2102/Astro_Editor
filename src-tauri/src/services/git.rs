use std::path::Path;
use std::process::{Command, Output};

use crate::error::AppError;
use crate::model::{ChangeKind, FileChange, GitStatus, ProjectContext, PublishResult};

fn run_git(root: &Path, args: &[&str]) -> Result<Output, AppError> {
    Command::new("git")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .map_err(|e| AppError::Git(format!("无法执行 git：{e}")))
}

/// 裁剪过的 stderr，用于把 git 的原始报错透传给用户
fn git_error_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        format!("git 退出码 {:?}", output.status.code())
    } else {
        trimmed.to_string()
    }
}

fn map_git_error(output: &Output) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("not a git repository") {
        return AppError::Git("项目目录不是 git 仓库".into());
    }
    AppError::Git(git_error_message(output))
}

pub fn status(ctx: &ProjectContext) -> Result<GitStatus, AppError> {
    // --untracked-files=all：默认 git 会把整个未跟踪目录折叠成一行（如 "src/"），
    // 这样匹配不到 content_dir 前缀，新建文章所在的全新子目录就会被漏判为 managed=false
    let output = run_git(
        &ctx.root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Err(map_git_error(&output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_porcelain_v2(&text, &ctx.config.content_dir))
}

fn is_managed(path: &str, content_dir: &str) -> bool {
    let content_dir = content_dir.trim_end_matches('/');
    path == content_dir || path.starts_with(&format!("{content_dir}/"))
}

fn classify(xy: &str) -> ChangeKind {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let code = if x != '.' { x } else { y };
    match code {
        'A' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'R' | 'C' => ChangeKind::Renamed,
        _ => ChangeKind::Modified,
    }
}

fn build_change(xy: &str, path: String, old_path: Option<String>, content_dir: &str) -> FileChange {
    let staged = xy.chars().next().is_some_and(|x| x != '.');
    let kind = classify(xy);
    let managed = is_managed(&path, content_dir);
    FileChange {
        path,
        old_path,
        kind,
        staged,
        managed,
    }
}

/// `1 XY sub mH mI mW hH hI path`（"1 " 已被调用方剥离）
fn parse_ordinary_fields(rest: &str) -> Option<(&str, &str)> {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    for _ in 0..6 {
        parts.next()?;
    }
    let path = parts.next()?;
    Some((xy, path))
}

/// `2 XY sub mH mI mW hH hI X<score> path`（origPath 是下一个 NUL 分隔的 token）
fn parse_rename_fields(rest: &str) -> Option<(&str, &str)> {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    for _ in 0..7 {
        parts.next()?;
    }
    let path = parts.next()?;
    Some((xy, path))
}

/// 解析 `git status --porcelain=v2 --branch -z` 的输出。
/// 用 -z 而不是默认的换行分隔，是因为文章标题常含中文/特殊字符，
/// 非 -z 模式下 git 会对路径做 C 风格转义，徒增解析负担。
pub fn parse_porcelain_v2(text: &str, content_dir: &str) -> GitStatus {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut changes = Vec::new();

    let mut tokens = text.split('\0').filter(|t| !t.is_empty());

    while let Some(tok) = tokens.next() {
        if let Some(rest) = tok.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = tok.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
        } else if let Some(rest) = tok.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if tok.starts_with("# ") {
            // 其他 header（如 branch.oid），忽略
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            if let Some((xy, path)) = parse_ordinary_fields(rest) {
                changes.push(build_change(xy, path.to_string(), None, content_dir));
            }
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            if let Some((xy, path)) = parse_rename_fields(rest) {
                let old_path = tokens.next().unwrap_or("").to_string();
                changes.push(build_change(
                    xy,
                    path.to_string(),
                    Some(old_path),
                    content_dir,
                ));
            }
        } else if let Some(rest) = tok.strip_prefix("u ") {
            if let Some(path) = rest.split_whitespace().last() {
                changes.push(FileChange {
                    path: path.to_string(),
                    old_path: None,
                    kind: ChangeKind::Unmerged,
                    staged: false,
                    managed: is_managed(path, content_dir),
                });
            }
        } else if let Some(path) = tok.strip_prefix("? ") {
            changes.push(FileChange {
                path: path.to_string(),
                old_path: None,
                kind: ChangeKind::Untracked,
                staged: false,
                managed: is_managed(path, content_dir),
            });
        }
        // "!" ignored 条目：没有传 --ignored，不会出现
    }

    GitStatus {
        branch,
        upstream,
        ahead,
        behind,
        changes,
    }
}

fn current_commit_hash(root: &Path) -> Option<String> {
    let output = run_git(root, &["rev-parse", "HEAD"]).ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn classify_push_error(stderr: &str) -> String {
    if stderr.contains("has no upstream branch") {
        "当前分支没有配置上游分支，请先在终端执行一次 git push -u <remote> <分支名>".to_string()
    } else if stderr.contains("Authentication failed")
        || stderr.contains("could not read Username")
        || stderr.contains("Permission denied (publickey)")
    {
        "推送失败（认证问题）：请检查 git 凭证或 SSH key 配置".to_string()
    } else {
        let trimmed = stderr.trim();
        if trimmed.is_empty() {
            "推送失败".to_string()
        } else {
            format!("推送失败：{trimmed}")
        }
    }
}

/// 依次 stage → commit → (push)，任何一步失败都停在那一步，
/// 已经完成的部分如实保留在结果里（不因为后面失败而抹掉前面的成功）。
pub fn publish(ctx: &ProjectContext, message: &str, push: bool) -> Result<PublishResult, AppError> {
    let current = status(ctx)?;

    let mut managed_paths: Vec<String> = Vec::new();
    for change in &current.changes {
        if change.managed {
            managed_paths.push(change.path.clone());
        }
        if let Some(old) = &change.old_path {
            if is_managed(old, &ctx.config.content_dir) {
                managed_paths.push(old.clone());
            }
        }
    }
    managed_paths.sort();
    managed_paths.dedup();

    if managed_paths.is_empty() {
        return Ok(PublishResult {
            staged: false,
            staged_files: vec![],
            committed: false,
            commit_hash: None,
            pushed: false,
            error_stage: Some("stage".into()),
            message: Some("没有可提交的改动".into()),
        });
    }

    let mut add_args = vec!["add", "--"];
    add_args.extend(managed_paths.iter().map(String::as_str));
    let add_output = run_git(&ctx.root, &add_args)?;
    if !add_output.status.success() {
        return Ok(PublishResult {
            staged: false,
            staged_files: vec![],
            committed: false,
            commit_hash: None,
            pushed: false,
            error_stage: Some("stage".into()),
            message: Some(git_error_message(&add_output)),
        });
    }

    let mut commit_args = vec!["commit", "-m", message, "--"];
    commit_args.extend(managed_paths.iter().map(String::as_str));
    let commit_output = run_git(&ctx.root, &commit_args)?;
    if !commit_output.status.success() {
        return Ok(PublishResult {
            staged: true,
            staged_files: managed_paths,
            committed: false,
            commit_hash: None,
            pushed: false,
            error_stage: Some("commit".into()),
            message: Some(git_error_message(&commit_output)),
        });
    }

    let commit_hash = current_commit_hash(&ctx.root);

    if !push {
        return Ok(PublishResult {
            staged: true,
            staged_files: managed_paths,
            committed: true,
            commit_hash,
            pushed: false,
            error_stage: None,
            message: None,
        });
    }

    let push_output = run_git(&ctx.root, &["push"])?;
    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Ok(PublishResult {
            staged: true,
            staged_files: managed_paths,
            committed: true,
            commit_hash,
            pushed: false,
            error_stage: Some("push".into()),
            message: Some(classify_push_error(&stderr)),
        });
    }

    Ok(PublishResult {
        staged: true,
        staged_files: managed_paths,
        committed: true,
        commit_hash,
        pushed: true,
        error_stage: None,
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProjectConfig;
    use std::path::PathBuf;

    fn porcelain(parts: &[&str]) -> String {
        let mut s = parts.join("\0");
        s.push('\0');
        s
    }

    #[test]
    fn parses_branch_header_and_modified_file() {
        let text = porcelain(&[
            "# branch.oid abc123",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 h1 h2 src/content/blog/a.md",
        ]);
        let status = parse_porcelain_v2(&text, "src/content/blog");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.changes.len(), 1);
        let c = &status.changes[0];
        assert_eq!(c.path, "src/content/blog/a.md");
        assert_eq!(c.kind, ChangeKind::Modified);
        assert!(!c.staged);
        assert!(c.managed);
    }

    #[test]
    fn distinguishes_staged_and_managed_scope() {
        let text = porcelain(&[
            "# branch.head main",
            "1 A. N... 000000 100644 100644 000000 h1 src/content/blog/new.md",
            "? src/content/blog/draft.md",
            "1 .M N... 100644 100644 100644 h1 h2 README.md",
        ]);
        let status = parse_porcelain_v2(&text, "src/content/blog");
        let by_path = |p: &str| status.changes.iter().find(|c| c.path == p).unwrap();

        let added = by_path("src/content/blog/new.md");
        assert_eq!(added.kind, ChangeKind::Added);
        assert!(added.staged);
        assert!(added.managed);

        let untracked = by_path("src/content/blog/draft.md");
        assert_eq!(untracked.kind, ChangeKind::Untracked);
        assert!(untracked.managed);

        let readme = by_path("README.md");
        assert!(!readme.managed);
    }

    #[test]
    fn parses_renamed_entry() {
        let text = porcelain(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 h1 h2 R100 src/content/blog/new-name.md",
            "src/content/blog/old-name.md",
        ]);
        let status = parse_porcelain_v2(&text, "src/content/blog");
        assert_eq!(status.changes.len(), 1);
        let c = &status.changes[0];
        assert_eq!(c.path, "src/content/blog/new-name.md");
        assert_eq!(
            c.old_path.as_deref(),
            Some("src/content/blog/old-name.md")
        );
        assert_eq!(c.kind, ChangeKind::Renamed);
    }

    #[test]
    fn fresh_repo_without_upstream_defaults_gracefully() {
        let text = porcelain(&[
            "# branch.oid (initial)",
            "# branch.head main",
            "? src/content/blog/a.md",
        ]);
        let status = parse_porcelain_v2(&text, "src/content/blog");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream, None);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn detached_head_has_no_branch_name() {
        let text = porcelain(&["# branch.head (detached)"]);
        let status = parse_porcelain_v2(&text, "src/content/blog");
        assert_eq!(status.branch, None);
    }

    // ---- 以下用真实 git 仓库跑集成测试 ----

    fn run(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(root)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} 失败");
    }

    fn commit_all(root: &Path, message: &str) {
        run(root, &["add", "-A"]);
        run(
            root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                message,
            ],
        );
    }

    fn init_repo() -> (tempfile::TempDir, ProjectContext) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        run(&root, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(root.join("src/content/blog")).unwrap();
        let ctx = ProjectContext {
            root: root.clone(),
            content_root: root.join("src/content/blog"),
            config: ProjectConfig {
                content_dir: "src/content/blog".into(),
                ..ProjectConfig::default()
            },
        };
        (dir, ctx)
    }

    fn init_bare(dir: &Path) -> PathBuf {
        let canon = dir.canonicalize().unwrap();
        run(&canon, &["init", "-q", "--bare"]);
        canon
    }

    #[test]
    fn status_on_fresh_repo_shows_untracked_managed_file() {
        let (_dir, ctx) = init_repo();
        std::fs::write(ctx.content_root.join("a.md"), "---\ntitle: a\n---\nbody").unwrap();

        let status = super::status(&ctx).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream, None);
        let a = status
            .changes
            .iter()
            .find(|c| c.path == "src/content/blog/a.md")
            .unwrap();
        assert_eq!(a.kind, ChangeKind::Untracked);
        assert!(a.managed);
    }

    #[test]
    fn publish_commits_only_managed_files() {
        let (_dir, ctx) = init_repo();
        std::fs::write(ctx.root.join("README.md"), "hello\n").unwrap();
        std::fs::write(ctx.content_root.join("a.md"), "original\n").unwrap();
        commit_all(&ctx.root, "init");

        std::fs::write(ctx.root.join("README.md"), "changed outside\n").unwrap();
        std::fs::write(ctx.content_root.join("a.md"), "changed inside\n").unwrap();

        let result = publish(&ctx, "更新文章", false).unwrap();
        assert!(result.staged);
        assert!(result.committed);
        assert!(result.commit_hash.is_some());
        assert!(!result.pushed);
        assert_eq!(result.error_stage, None);
        assert_eq!(result.staged_files, vec!["src/content/blog/a.md".to_string()]);

        let show = Command::new("git")
            .current_dir(&ctx.root)
            .args(["show", "HEAD:README.md"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&show.stdout), "hello\n");

        let status_after = Command::new("git")
            .current_dir(&ctx.root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&status_after.stdout);
        assert!(s.contains("README.md"));
        assert!(!s.contains("a.md"));
    }

    #[test]
    fn publish_with_no_changes_reports_stage_error_without_running_git() {
        let (_dir, ctx) = init_repo();
        std::fs::write(ctx.content_root.join("a.md"), "x\n").unwrap();
        commit_all(&ctx.root, "init");

        let result = publish(&ctx, "空提交", false).unwrap();
        assert!(!result.staged);
        assert!(!result.committed);
        assert_eq!(result.error_stage.as_deref(), Some("stage"));
        assert_eq!(result.message.as_deref(), Some("没有可提交的改动"));
    }

    #[test]
    fn publish_push_succeeds_against_local_bare_remote() {
        let (_dir, ctx) = init_repo();
        let origin_dir = tempfile::tempdir().unwrap();
        let origin_path = init_bare(origin_dir.path());
        run(
            &ctx.root,
            &["remote", "add", "origin", origin_path.to_str().unwrap()],
        );
        std::fs::write(ctx.content_root.join("a.md"), "x\n").unwrap();
        commit_all(&ctx.root, "init");
        run(&ctx.root, &["push", "-q", "-u", "origin", "main"]);

        std::fs::write(ctx.content_root.join("a.md"), "y\n").unwrap();
        let result = publish(&ctx, "更新", true).unwrap();
        assert!(result.staged);
        assert!(result.committed);
        assert!(result.pushed);
        assert_eq!(result.error_stage, None);
    }

    #[test]
    fn publish_push_without_upstream_reports_friendly_message() {
        let (_dir, ctx) = init_repo();
        let origin_dir = tempfile::tempdir().unwrap();
        let origin_path = init_bare(origin_dir.path());
        run(
            &ctx.root,
            &["remote", "add", "origin", origin_path.to_str().unwrap()],
        );

        std::fs::write(ctx.content_root.join("a.md"), "x\n").unwrap();
        let result = publish(&ctx, "首次提交", true).unwrap();
        assert!(result.committed);
        assert!(!result.pushed);
        assert_eq!(result.error_stage.as_deref(), Some("push"));
        assert!(result.message.as_ref().unwrap().contains("上游"));
    }
}
