# Arch Linux 安装

该目录提供只面向 Arch Linux 原生 Wayland 会话的 `blog-editor-git` 包。

```bash
sudo pacman -S --needed base-devel git
cd packaging/arch
makepkg -si
```

`makepkg` 会从 GitHub `main` 获取源码、按 lockfile 构建前端和 Rust
release 二进制，再通过 pacman 安装：

- `/usr/bin/blog-editor`：检查 `WAYLAND_DISPLAY` 并强制 GTK Wayland backend；
- `/usr/lib/blog-editor/blog-editor`：实际 Tauri 二进制；
- desktop entry 与 hicolor 图标。

更新时在本目录重新运行 `makepkg -si`；卸载使用：

```bash
sudo pacman -Rns blog-editor-git
```

这是 VCS 包，只构建已经推送到 GitHub 的提交；工作区中的未提交内容不会进入安装包。
项目暂未选择开源许可证，包元数据因此使用
`LicenseRef-All-Rights-Reserved`。
