fn main() {
    // 声明应用命令清单：只有声明过的命令会生成 allow-* 权限，
    // 再由 capabilities/ 决定哪个窗口可以调用（见 docs/blog-editor-architecture.md 安全边界模型）
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "select_project",
                "get_project",
                "list_posts",
                "read_post",
                "write_post",
                "create_post",
                "rename_post",
                "list_tags",
                "save_image",
                "git_status",
                "git_publish",
                "ensure_preview_server",
                "stop_preview_server",
                "get_preview_status",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
