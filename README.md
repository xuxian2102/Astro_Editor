# Blog Editor

[![Arch Wayland CI](https://github.com/xuxian2102/Astro_Editor/actions/workflows/linux.yml/badge.svg)](https://github.com/xuxian2102/Astro_Editor/actions/workflows/linux.yml)

面向个人 Astro 博客的原生 Markdown 编辑器。应用基于 Tauri v2、React、
CodeMirror 6 和 WebKitGTK，只支持 **Arch Linux rolling + 原生 Wayland**。

## 功能

- 保留 YAML 注释、字段顺序和引号风格的 Frontmatter 表单编辑；
- Markdown 实时排版与源码模式热切换，保留选区和撤销历史；
- 从 Wayland 剪贴板粘贴图片、拖入图片，并使用文章同名目录管理资产；
- 启动博客自己的 Astro 开发服务器，在无 Tauri 权限的独立窗口中预览真实页面；
- 新建、重命名和可恢复删除文章，检测外部修改并提供崩溃草稿恢复；
- 查看 Git 状态，提交当前编辑器管理的文章和图片，并可选择推送；
- 原生 Wayland/WebKitGTK 端到端测试和 Arch `makepkg` 安装包。

项目不支持 X11/XWayland、其他 Linux 发行版、Windows、macOS 或 MDX。

## 安装

安装构建工具，然后通过仓库中的 VCS 包安装：

```bash
sudo pacman -S --needed base-devel git
git clone https://github.com/xuxian2102/Astro_Editor.git
cd Astro_Editor/packaging/arch
makepkg -si
```

启动器会检查 `WAYLAND_DISPLAY` 并强制 GTK 使用原生 Wayland。更新代码后在
`packaging/arch` 中重新运行 `makepkg -si`；卸载使用：

```bash
sudo pacman -Rns blog-editor-git
```

## 博客项目配置

编辑器打开的博客根目录需要包含 `.blog-editor.json`。最小示例：

```json
{
  "version": 1,
  "contentDir": "src/content/blog",
  "extensions": [".md"],
  "frontmatter": {
    "fields": [
      { "name": "title", "type": "string", "required": true },
      { "name": "pubDate", "type": "date", "required": true },
      { "name": "draft", "type": "boolean", "default": false },
      { "name": "tags", "type": "tags" }
    ]
  },
  "preview": {
    "command": "node_modules/.bin/astro",
    "args": ["dev"],
    "host": "127.0.0.1",
    "port": 4321,
    "routeTemplate": "/blog/{slug}"
  },
  "assets": { "mode": "colocated" }
}
```

预览命令相对于博客根目录运行。请先在博客项目内安装依赖，确保配置中的 Astro
可执行文件存在。

## 开发

项目使用 Arch 官方仓库的 `rust`，由 `pacman -Syu` 更新；不需要 `rustup`。
Node.js 版本记录在 `.nvmrc`，pnpm 主版本记录在 `package.json`。

```bash
sudo pacman -S --needed \
  base-devel git rust nodejs pnpm webkit2gtk-4.1 \
  curl wget file openssl appmenu-gtk-module libappindicator librsvg
pnpm install --frozen-lockfile
pnpm tauri dev
```

常用检查：

```bash
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
```

原生端到端测试还需要 `sway`、`wl-clipboard`、`dbus` 和 `ttf-dejavu`：

```bash
sudo pacman -S --needed sway wl-clipboard dbus ttf-dejavu
pnpm test:e2e
```

### 前端文案

前端用户可见文案集中在 `src/i18n/zh-CN.ts`。React 组件使用类型安全的
`useTranslation()` selector，非 React 模块使用同一个 i18n 实例；新增文案时先添加
目录键，再在代码里按键引用。`pnpm test` 会扫描 `src`，阻止中文界面文案重新写回
实现文件。Rust 命令错误、Git 发布错误和异步预览错误统一传输
`{ code, params, fallback }`：已知错误码由前端目录翻译，未知错误码显示 Rust 提供的
fallback，保证前后端升级期间仍有可读诊断。错误码及插值参数集中登记在
`shared/error-codes.json`；Rust 错误码注册表与命名构造器、TypeScript 翻译表共同检查
契约，新增错误码时缺少任一端实现都会让测试或构建失败。

`pnpm check` 使用 Biome 同时检查前端格式、React Hook 依赖和可访问性规则。生产主窗口
还启用严格 CSP：脚本只允许应用自身资源，IPC 只允许 Tauri 通道；图片预览额外允许
Blob、data URL 和 HTTP(S) 图片。自定义对话框会圈定键盘焦点，支持安全的 Escape
取消，并在关闭后把焦点还给触发控件。

## 诊断日志

安装版把 Rust 后端的生命周期、清理失败和预览错误写入：

```text
${XDG_DATA_HOME:-$HOME/.local/share}/dev.xuxian.blogeditor/logs/blog-editor.log
```

单个文件最多 1 MiB，并保留最多两个轮转文件。应用不会主动记录文章正文或 Git
凭证；错误消息可能含本机路径，提交问题前请自行检查。

更详细的权限边界、文件事务、预览进程和图片资产设计见
[`docs/blog-editor-architecture.md`](docs/blog-editor-architecture.md)。Arch 包说明见
[`packaging/arch/README.md`](packaging/arch/README.md)。版本变更见
[`CHANGELOG.md`](CHANGELOG.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
