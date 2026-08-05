# Changelog

本项目的重要变更记录在此。版本号遵循 [Semantic Versioning](https://semver.org/)。

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
