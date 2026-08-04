# 个人博客写作工具 — 架构设计

## 核心原则

> 主窗口是受信编辑器，预览窗口是不受信网页；Rust 是唯一的文件和 Git 权限边界；真实运行的 Astro 是最终渲染的真相来源；CodeMirror 的实时预览只负责编辑时的视觉体验，不定义、不影响实际输出。

---

## 技术栈

| 层 | 用什么 |
|---|---|
| 应用外壳 | Tauri v2（Rust 后端 + WebKitGTK） |
| 前端框架 | React + TypeScript |
| 编辑器 | CodeMirror 6 + 自定义 ViewPlugin（实时预览装饰器） |
| Frontmatter | `yaml` 包的 `Document` API（保留注释/顺序/引号风格），不用 gray-matter |
| 网页预览 | 按需 spawn 项目自己的 `astro dev`，独立 WebviewWindow 展示 |
| Git | Rust 侧 `std::process::Command` 直接调系统 git，参数走数组 |
| 打包 | `cargo tauri build`，个人使用不需要 Flatpak/AppImage 分发 |

---

## 安全边界模型

这是整个架构里唯一不能妥协的部分。

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│   主窗口 "main"（受信）        │     │   预览窗口 "preview"（不受信）   │
│                               │     │                                │
│   React 应用 / CodeMirror     │     │   http://127.0.0.1:4321/...   │
│   文件树 / Frontmatter 表单   │     │   （Astro 渲染出的真实页面，    │
│   Git 面板                    │     │    可能含第三方脚本/开发工具）   │
│                               │     │                                │
│   → 可以 invoke 应用命令      │     │   → 不分配任何应用命令权限      │
└─────────────────────────────┘     └──────────────────────────────┘
              │                                      │
              └──────────────┬───────────────────────┘
                              ▼
                    Rust 后端（唯一权限边界）
```

**为什么必须是独立窗口，不能是主窗口里的 `<iframe>`**：Tauri 官方文档原话——"On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself"；同时"By default, all commands that you registered in your app... are allowed to be used by all the windows and webviews of the app"。两条叠加，如果预览用 iframe 嵌在主窗口里，理论上预览页面里的任意脚本都摸得到 `write_post`、`git_push` 这些命令。

**具体做法**：

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "list_posts", "read_post", "write_post", "save_image",
                "git_status", "git_stage", "git_commit", "git_push",
                "ensure_preview_server", "stop_preview_server",
            ]),
        ),
    )
    .unwrap();
}
```

```json
// src-tauri/capabilities/main.json
{
  "identifier": "main-capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "allow-list-posts", "allow-read-post", "allow-write-post", "allow-save-image",
    "allow-git-status", "allow-git-stage", "allow-git-commit", "allow-git-push",
    "allow-ensure-preview-server", "allow-stop-preview-server"
  ]
}
```

`preview` 窗口不出现在任何授予这些命令的 capability 的 `windows` 列表里，因此默认无权调用。实现时以 Tauri 生成的 schema 为准核对具体权限标识符命名。

---

## 目录结构

```
my-blog-editor/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs                    # AppManifest::commands 声明
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── main.json               # 只授权给 "main" 窗口
│   └── src/
│       ├── main.rs
│       ├── lib.rs                  # 注册 command、创建 preview 窗口
│       ├── state.rs                # AppState：按用途分锁，不用一把大锁
│       ├── model.rs                # PostDocument / PreviewStatus / PublishResult
│       ├── error.rs                # AppError，统一错误转换
│       ├── path_guard.rs           # PostId 解析、路径校验、防越权
│       ├── commands/                # 薄封装：反序列化 → 调 service → 转错误
│       │   ├── mod.rs
│       │   ├── project.rs
│       │   ├── posts.rs
│       │   ├── git.rs
│       │   └── preview.rs
│       └── services/                # 可单测的业务逻辑
│           ├── mod.rs
│           ├── project.rs           # 加载 .blog-editor.json
│           ├── posts.rs             # 原子写、revision 校验
│           ├── git.rs               # status/stage/commit/push
│           └── preview.rs           # PreviewManager：进程组生命周期
│
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── domain/
│   │   ├── frontmatterDocument.ts  # yaml.Document 包一层，读写指定字段
│   │   └── postSession.ts          # 正文 + frontmatter + revision + dirty 状态
│   ├── lib/
│   │   └── tauriApi.ts             # 封装所有 invoke()，统一类型
│   ├── editor/
│   │   ├── LivePreviewEditor.tsx
│   │   ├── livePreview.ts          # 唯一的 ViewPlugin：一次遍历、一个 DecorationSet
│   │   ├── theme.ts
│   │   └── decorators/
│   │       ├── index.ts            # decoratorRegistry
│   │       ├── heading.ts
│   │       ├── strong.ts
│   │       ├── emphasis.ts
│   │       ├── inlineCode.ts
│   │       ├── link.ts
│   │       └── fencedCode.ts
│   └── components/
│       ├── Sidebar.tsx
│       ├── FrontmatterForm.tsx
│       ├── TagEditor.tsx
│       ├── PreviewController.tsx   # 请求启动/获取 URL/创建预览窗口，不直接承载网页
│       └── GitPanel.tsx            # 提交 / 提交并推送 两个按钮
│
├── package.json
└── vite.config.ts
```

---

## 核心数据模型

```rust
// model.rs
struct PostId(String);              // 相对 content root 的受控标识，不是绝对路径

struct PostDocument {
    id: String,
    relative_path: String,
    raw_frontmatter: String,        // 原始 YAML 文本，不转成 JS 对象再序列化
    body: String,
    revision: String,               // 内容哈希，用于检测外部修改
}

enum PreviewStatus {
    Stopped,
    Starting,
    Ready { url: String, pid: u32 },
    Failed { message: String },
}

struct PublishResult {
    staged: bool,
    committed: bool,
    commit_hash: Option<String>,
    pushed: bool,
    error_stage: Option<String>,    // "status" | "stage" | "commit" | "push"
    message: Option<String>,
}
```

```rust
// state.rs —— 按用途分锁，避免一把大锁堵住所有命令
struct AppState {
    project: RwLock<Option<ProjectContext>>,
    preview: Mutex<PreviewManager>,
    git_lock: Mutex<()>,            // 防止并发发布
}
```

等 HTTP 轮询、git push、子进程退出这类耗时操作时，不持有以上任何锁。

---

## 关键机制

### 1. Frontmatter：保留原始结构

不做 `parse → 普通对象 → stringify`，避免丢注释、字段顺序、引号风格。前端用 `yaml` 包的 `Document` API 解析 `raw_frontmatter`，表单只改动自己负责的字段，未识别的自定义字段原样保留。

```
完整 Markdown 文件
    ├── raw_frontmatter → YAML.Document → FrontmatterForm
    └── body → CodeMirror
```

### 2. 文件读写：PostId + 校验 + 原子写 + revision

- 前端只传 `PostId`，从不传绝对路径；project root 只存在 Rust `AppState` 里
- 后端校验：不允许绝对路径、不允许 `..`、只接受 `.md`、解析后必须仍在 content root 内
- 写入用临时文件 + rename，避免写到一半崩溃产生半截文件
- 读取返回 `revision`，保存时传回 `expected_revision`；不一致时返回 `ExternalModificationConflict` 而不是静默覆盖（对应场景：git checkout 切换分支、另一个编辑器同时保存）

### 3. 预览：独立窗口 + 进程组管理 + 就绪轮询 + 路由模板

- 不硬编码 `Command::new("astro")`，改为 spawn 项目内 `node_modules/.bin/astro dev`（或按配置的 command/args），因为图形界面启动时的 `PATH` 未必包含终端里那份
- 显式传 `--host 127.0.0.1`，不用裸 `--host`（会监听所有网卡）
- 用 `CommandExt::process_group`（Unix）把 astro dev 放进独立进程组，停止预览/切换项目/应用退出时对整个进程组发信号，避免 npm/pnpm 包一层导致杀不干净
- spawn 后不立刻打开页面，轮询 `http://127.0.0.1:PORT/` 直到可访问、子进程提前退出、或超时
- 文件路径不能直接推出 URL（Content Collections、自定义 slug、i18n 都会打破这个假设），路由映射走配置里的 `routeTemplate`

### 4. Git：拆分步骤 + 结构化结果

后端拆成 `git_status` / `git_stage` / `git_commit` / `git_push`，UI 上可以只保留"提交"和"提交并推送"两个按钮，但底层分开调用，返回 `PublishResult` 而不是简单的成功/失败——commit 成功但 push 失败是真实会发生的场景，不能笼统报错导致用户重复提交。

- 第一版只 stage 编辑器管理的文章和图片，不静默执行 `git add .`
- 设置 `GIT_TERMINAL_PROMPT=0`，避免图形界面下 git 卡在凭证输入
- `git_lock` 防止并发发布

### 5. 实时预览：单次遍历 + 不变量

核心是一个 `ViewPlugin`，文档/光标/可见区域变化时重新计算一次 `syntaxTree` 遍历，所有装饰写进同一个 `DecorationSet`，`decoratorRegistry` 按节点类型分发（heading → strong → emphasis → inlineCode → link → fencedCode 的开发顺序不变，链接和代码块逻辑最复杂，放最后）。

需要作为验收标准的不变量：

1. 装饰永远不修改源 Markdown
2. 光标/选区与语法节点相交时恢复原始符号
3. **输入法组合期间不替换当前编辑节点**（中文输入法在 Wayland 下的 composition 事件容易被装饰器打断，第一批就要测）
4. 复制内容是 Markdown 原文，不是渲染后的视觉文本
5. Undo/redo 不受装饰影响
6. 只处理 `visibleRanges`，不对整篇文档跑遍历
7. 保存结果与关闭实时预览后看到的内容完全一致

第一版只支持 `.md`，不做 `.mdx`（JSX 节点、组件属性会显著增加复杂度）。

---

## 项目配置文件

区分应用级设置（最近打开项目、UI 主题、窗口状态）和项目级设置，后者放项目根目录的 `.blog-editor.json`：

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
  "assets": {
    "mode": "colocated"
  }
}
```

保留 `version` 字段，方便以后配置结构变化时做迁移。

---

## 开发阶段

**阶段 1：项目与文件正确性**
选择/验证 Astro 项目、加载 `.blog-editor.json`、列出文章、读取文章、frontmatter 与正文分离、基础 CodeMirror（无实时预览）、原子保存、revision 冲突检测、新建/重命名、路径越权测试。
不做：删除、Git、预览、自动保存。
验收标准：能安全打开保存真实博客文章，不破坏未识别的 frontmatter 字段。

**阶段 2：Git**
status / diff / stage / commit / push、部分成功状态、无 upstream/认证失败提示。到这一步已经是可实际使用的博客编辑器。

**阶段 3：真实 Astro 预览**
PreviewManager、独立无权限的 preview 窗口、绑定 127.0.0.1、就绪检查、路由模板、项目切换/应用退出时清理进程组、"在系统浏览器打开"按钮（因为 WebKitGTK 渲染不等于目标读者用的浏览器，构建管线一致不等于像素级一致）。

**阶段 4：图片、标签、设置**
图片粘贴/拖拽、文件名冲突处理、标签索引与自动补全、项目配置 UI、删除文章及资产确认。

**阶段 5：Obsidian 式实时预览**
heading → strong → emphasis → inlineCode → link → fencedCode，IME/选区/复制/撤销测试作为验收的一部分，不是事后补充。

即使实时预览最后没按期完成，前四个阶段已经是一个完整可用的工具。
