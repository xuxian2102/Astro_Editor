# Changelog

本项目的重要变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [0.1.2] - 2026-08-05

### Added

- 集中管理中文界面文案，并以共享清单约束 Rust 与 TypeScript 的结构化错误码和插值参数。
- 为自定义对话框补齐初始焦点、焦点圈定、Escape 语义、焦点恢复及真实 WebKitGTK 回归。
- 主窗口启用严格 CSP；生产 custom protocol 与桌面 Vite 开发路径均纳入 Wayland E2E 验收。

### Fixed

- 修复弹窗打开时半成品标签被意外提交、文章新建或重命名输入被静默取消的问题。
- 修复叠加弹窗的视觉层级与键盘焦点栈不一致，导致不可见确认框接收操作的问题。
- 修复预览启动超时或运行后崩溃时，最后一段 stdout/stderr 可能未进入诊断日志的问题。
- 修复桌面端 `tauri dev` 直接加载 Vite 时没有实际应用开发 CSP 的问题。

### Changed

- 错误 payload 改用参数类型明确的命名构造器，序列化不再因手工参数不匹配而退化为不透明 IPC 错误。
- 发布检查增加 Biome 可访问性与 Hook 规则、前后端错误协议校验及更完整的原生 Wayland 场景。

## [0.1.1] - 2026-08-05

### Fixed

- 修复安装版窗口收到关闭请求后因缺少 `destroy` 权限而无法退出。
- 修复中文输入法组合期间，光标之外的已渲染图片退回 Markdown 源码。

### Added

- release 构建写入有大小与数量上限的本地诊断日志。
- 原生 Wayland E2E 增加由 Sway compositor 发起的真实关闭握手回归；发布标签同时验证文件日志。

## [0.1.0] - 2026-08-04

- 首个可用版本：安全的 Markdown/Frontmatter 编辑、实时排版、Wayland 图片导入、
  Astro 实页预览、草稿恢复、文章与资产管理、Git 发布以及 Arch `makepkg` 安装。
