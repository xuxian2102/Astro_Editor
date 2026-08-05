# 个人博客写作工具 — 架构设计

当前运行契约只有 **Arch Linux rolling + 原生 Wayland**（Tauri v2 + WebKitGTK），并且只是个人项目。X11/XWayland、其他 Linux 发行版、Windows 与 macOS 都不在构建、运行或 CI 范围内。

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
| Markdown 结构化改写 | `pulldown-cmark` 事件流 + 源码字节范围，只改图片 URL |
| 可恢复删除 | `trash` crate，进入 Linux 桌面环境的系统废纸篓 |
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
                "list_posts", "read_post", "write_post", "save_image", "read_image_asset",
                "write_draft", "read_draft", "delete_draft", "git_status", "git_publish",
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
    "allow-read-image-asset", "allow-write-draft", "allow-read-draft", "allow-delete-draft",
    "allow-git-status", "allow-git-publish",
    "allow-ensure-preview-server", "allow-stop-preview-server"
  ]
}
```

`preview` 窗口不出现在任何授予这些命令的 capability 的 `windows` 列表里，因此默认无权调用。实现时以 Tauri 生成的 schema 为准核对具体权限标识符命名。

主窗口同时启用 CSP：`script-src` 只允许自身，`connect-src` 只允许 Tauri IPC；内嵌图片
预览按实际功能放行 `blob:`、`data:` 与 HTTP(S)，不放行远程脚本。开发配置只比生产
配置多出 Vite 本地 WebSocket；桌面端 `tauri dev` 直接加载 Vite URL，因此
`vite.config.ts` 会把同一份 `devCsp` 序列化成开发服务器响应头。原生 WebKitGTK E2E
通过 document-start 初始化脚本监听 `securitypolicyviolation`，覆盖 HTML 解析和首批资源
加载，并在完成 IPC、CodeMirror 与 Blob 图片流程后断言没有策略阻断。

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
│       ├── main.rs                 # 正常应用入口
│       ├── e2e_main.rs             # 仅 e2e feature 可构建的独立测试入口
│       ├── lib.rs                  # 注册 command、创建 preview 窗口
│       ├── state.rs                # AppState：按用途分锁，不用一把大锁
│       ├── model.rs                # PostDocument / PreviewStatus / PublishResult
│       ├── error.rs                # AppError，统一错误转换
│       ├── path_guard.rs           # PostId 解析、路径校验、防越权
│       ├── commands/                # 薄封装：反序列化 → 调 service → 转错误
│       │   ├── mod.rs
│       │   ├── project.rs
│       │   ├── posts.rs
│       │   ├── assets.rs
│       │   ├── drafts.rs
│       │   ├── git.rs
│       │   └── preview.rs
│       └── services/                # 可单测的业务逻辑
│           ├── mod.rs
│           ├── project.rs           # 加载 .blog-editor.json
│           ├── posts.rs             # 原子写、revision 校验
│           ├── assets.rs            # 图片落盘、待提交登记与保守清理
│           ├── clipboard.rs         # Linux 原生剪贴板、数量与字节预算
│           ├── drafts.rs            # 原子恢复日志（0600）
│           ├── git.rs               # status/publish
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
│   │   ├── MarkdownEditor.tsx      # 编辑器生命周期、图片输入、Compartment 模式切换
│   │   ├── imagePaste.ts           # 粘贴/拖拽图片的纯逻辑与事务入口
│   │   ├── livePreview.ts          # 唯一的 ViewPlugin：可见区遍历与 DecorationSet
│   │   ├── livePreviewStructural.ts # 引用、列表、任务项、表格节点规则
│   │   ├── livePreviewWidgets.ts    # 代码语言、列表、任务框、图片 Widget
│   │   ├── livePreview.test.ts     # 选区、IME、可见区、源码/撤销不变量
│   │   └── livePreview.performance.test.ts # 1 MiB 长文档的可见区帧预算
│   └── components/
│       ├── Sidebar.tsx
│       ├── FrontmatterForm.tsx
│       ├── TagEditor.tsx
│       ├── PreviewController.tsx   # 请求启动/获取 URL/创建预览窗口，不直接承载网页
│       └── GitPanel.tsx            # 提交 / 提交并推送 两个按钮
├── shared/
│   └── error-codes.json             # Rust/TypeScript 共用的错误码与参数契约
├── biome.json                       # 前端格式、Hook 依赖与可访问性检查
│
├── test/e2e/
│   ├── run-wayland.sh              # 隔离 headless Wayland compositor，禁用 XWayland
│   ├── wdio.conf.mjs               # 临时项目 + 嵌入式 Tauri WebDriver
│   └── specs/editor-smoke.e2e.mjs  # WebKitGTK 编辑 + Wayland 图片 Ctrl+V 闭环
├── packaging/arch/
│   ├── PKGBUILD                    # blog-editor-git，可由 pacman 管理
│   ├── blog-editor.sh              # 强制原生 Wayland 的启动包装器
│   └── dev.xuxian.blogeditor.desktop
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

struct ErrorPayload {
    code: String,                   // 稳定机器码
    params: Map<String, Value>,     // 前端翻译插值参数
    fallback: String,               // 未知 code / 版本错配时的可读诊断
}

enum PreviewStatus {
    Stopped,
    Starting,
    Ready { url: String, pid: u32 },
    Failed { error: ErrorPayload, log_tail: String },
}

struct PublishResult {
    staged: bool,
    committed: bool,
    commit_hash: Option<String>,
    pushed: bool,
    error_stage: Option<String>,    // "stage" | "commit" | "push"
    error: Option<ErrorPayload>,
}
```

Tauri 命令的 `AppError` 也序列化为同一个 `ErrorPayload`。前端优先按 `code` 从
`src/i18n/zh-CN.ts` 选择文案并代入 `params`；不认识的错误码直接显示 `fallback`。
因此命令拒绝、Git 部分成功和异步预览失败不会再形成三套互不兼容的字符串协议。
`shared/error-codes.json` 是代码名和参数名清单：Rust 只允许用登记过的 `ErrorCode`
构造 payload，序列化时拒绝缺失或多余参数；Rust 单测核对清单，TypeScript 用
`satisfies Record<KnownAppErrorCode, ...>` 保证每个登记代码都有翻译函数。

```rust
// state.rs —— 按用途分锁，避免一把大锁堵住所有命令
struct AppState {
    project: RwLock<Option<ProjectContext>>,
    project_generation: AtomicU64,    // 每次切换递增，拒绝晚到的跨项目请求
    content_lock: Mutex<()>,          // 串行化文章/资产变更，并与项目切换互斥
    pending_assets: Mutex<PendingAssetManager>,
    preview: Mutex<PreviewManager>,
    git_lock: Mutex<()>,            // 防止并发发布
}
```

HTTP 轮询和预览子进程退出不跨越状态锁；Git 发布为了给 stage → commit → push 提供项目租约，会在整段操作中持有 `content_lock`，并由命令超时约束最长等待。

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
- 每个项目级 IPC 都携带 `projectGeneration`；后端在 `content_lock` 内同时核对 generation 与 `ProjectContext`。前端对文章打开、文章列表、标签和 Git 状态另设 request epoch，忽略乱序返回的旧读取。
- 保存使用不可变快照；响应回来时只推进磁盘 revision，并与当前编辑状态合并。保存期间新增的正文或 Frontmatter 继续保持 dirty。CodeMirror 的 editor epoch 与 revision 分离，普通保存不会重建编辑器或清空 undo。

### 2.1 自动恢复与关闭保护

- dirty 内容以 700ms 防抖写入 Tauri app-data 下的项目/文章隔离草稿，文件采用同目录临时文件、`sync_all`、原子替换与 `0600` 权限。
- 草稿写入与删除走同一前端队列；正文保存成功后排队删除，避免迟到写入把已保存草稿重新复活。
- 再次打开文章时比较草稿内容、`baseRevision` 与最新磁盘文档：相同则静默清理；不同则让用户选择恢复草稿或使用磁盘版本，磁盘已变化时明确告警。
- 正常关闭时若文字、图片导入或保存仍未完成，会阻止窗口退出并提供保存/放弃选择。
- Tauri 的 JS `onCloseRequested` 在未阻止事件时仍会调用 `destroy()` 完成握手，因此受信任的 main 窗口必须显式拥有 `core:window:allow-destroy`；Rust 单测锁定权限，Sway E2E 从 compositor 发出真实关闭请求并断言进程正常退出。

### 2.2 发布诊断日志

debug/E2E 构建只向 stdout 输出日志；release 构建只写 Tauri app-log 目录中的
`blog-editor.log`。单个文件限制为 1 MiB，并保留最多两个轮转文件，避免个人工具长期运行后无界占用磁盘。日志覆盖应用启动、退出清理和 Rust 错误路径，不主动记录文章正文或 Git 凭证；底层错误可能包含本机路径。

### 3. 预览：独立窗口 + 进程组管理 + 就绪轮询 + 路由模板

- 不硬编码 `Command::new("astro")`，改为 spawn 项目内 `node_modules/.bin/astro dev`（或按配置的 command/args），因为图形界面启动时的 `PATH` 未必包含终端里那份
- 显式传 `--host 127.0.0.1`，不用裸 `--host`（会监听所有网卡）
- 用 `CommandExt::process_group`（Unix）把 astro dev 放进独立进程组，停止预览/切换项目/应用退出时对整个进程组发信号，避免 npm/pnpm 包一层导致杀不干净
- spawn 后不立刻打开页面，轮询 `http://127.0.0.1:PORT/` 直到可访问、子进程提前退出、或超时
- 文件路径不能直接推出 URL（Content Collections、自定义 slug、i18n 都会打破这个假设），路由映射走配置里的 `routeTemplate`
- 默认文件 slug 与 Astro 5 `glob()` loader 一致：逐路径段走 GitHub slugger，并优先采用 frontmatter 的 `slug`；资产目录仍保留真实文件名大小写，不能与 URL slug 共用转换函数

### 4. Git：事务化发布 + 结构化结果

后端暴露 `git_status` 与一次事务化的 `git_publish`；`git_publish` 内部仍按 stage → commit → 可选 push 分步执行，并返回 `PublishResult`。commit 成功但 push 失败会如实呈现，不能笼统报错导致用户重复提交。

- 第一版只 stage 编辑器管理的文章、图片和 `.blog-editor.json`，不静默执行 `git add .`
- 设置 `GIT_TERMINAL_PROMPT=0`，避免图形界面下 git 卡在凭证输入
- `content_lock` 让发布与文章、图片和项目切换互斥，`git_lock` 防止并发发布；存在 pending 图片或任何 unmerged 项时，在修改 index 前硬阻断

### 5. 图片资产：待提交事务 + 结构化重命名 + 可恢复删除

图片粘贴天然跨两个动作：先把二进制文件落盘，再把 Markdown 引用插进编辑器。不能假设第二步必然保存，因此 Rust 侧维护一个仅属于当前应用会话的 `PendingAssetManager`：

1. 前端先读取标准 `ClipboardEvent`；WebKitGTK 隐藏图片数据或文件管理器只给 URI MIME 时，`import_clipboard_images` 在 blocking worker 中绕开 WebKit。文件列表由 `arboard` 读取，Wayland 原始位图按 compositor 实际提供的 `image/*` MIME 由 `wl-clipboard-rs` 读取，避免只请求 `image/png` 的兼容性缺口。
2. `save_image` 使用原始二进制 IPC，并以同目录临时文件 + `persist_noclobber` 写入 `<文章 stem>/<文件名>`；单张限制 25 MiB、批量限制 20 张/100 MiB。它记录新建文件的规范路径和内容哈希；命中相同内容时复用现有文件，但不取得其所有权。
3. `write_post` 成功后按磁盘正文对账：已被图片节点引用的文件解除待提交标记，撤销后没有引用的文件删除。
4. 放弃编辑、切换项目和正常退出时执行同一套保守清理；文件内容被外部改过或磁盘正文已经引用时一律保留。
5. 重命名先校验 revision，再用 `pulldown-cmark` 的图片事件与源码范围只改图片目标，代码块、普通链接、alt/title 和 frontmatter 保持原字节；只移动正文直接引用且位于同名目录的图片，目录内其他文件和嵌套文章原地保留。
6. 删除再次校验 revision，只把文章及其直接引用的同目录图片送入系统废纸篓，不把“同 stem 目录”推断成整篇文章所有，也不做永久递归删除。
7. 编辑器内嵌图片通过 `read_image_asset` 读取原始字节：目标必须相对当前文章，percent decode 和 canonicalize 后仍在 `content_root` 内，且扩展名和 25 MiB 上限通过验证；不启用宽泛的 asset protocol 文件系统 scope。

`a.md` 与 `a/nested.md` 可以同时存在，此时 `a/` 既可能容纳图片，也可能是内容层级，永远不视为 `a.md` 独占目录。所有权按 Markdown AST 中的直接图片引用逐文件计算。

### 6. 实时预览：单次遍历 + 不变量

核心是一个 `ViewPlugin`，文档/光标/可见区域或 Lezer 后台语法树变化时，只遍历 `visibleRanges` 内的 `syntaxTree`；所有视觉装饰写进同一个 `DecorationSet`。被隐藏的语法标记另生成一个只供 `atomicRanges` 使用的集合，避免方向键落进视觉上的零宽区域。异步图片使用最多 64 项的 LRU Blob URL 缓存；淘汰和插件销毁都会 revoke。

编辑器用 CodeMirror `Compartment` 在“实时排版”和“源码显示”之间热切换，不重建 `EditorState`，因此正文、选区和 undo 历史都保留。当前已完成 ATX/Setext heading、strong、emphasis、strikethrough、inlineCode、普通链接与自动链接、fencedCode、单行 image、horizontal rule、blockquote、bullet/ordered list、task list 与 GFM table；图片字节异步加载后通过 Blob URL 缓存，插件销毁时统一 revoke，加载完成会通知 CodeMirror 重新测量布局。任务复选框是显式编辑动作，只替换 `TaskMarker` 中间的一个字符，因此正常进入 dirty 与 undo 历史。

需要作为验收标准的不变量：

1. 装饰计算永远不修改源 Markdown；只有用户点击任务复选框时执行显式源码事务
2. 光标/选区与语法节点相交时恢复原始符号
3. **输入法组合期间不替换当前编辑节点**；`compositionend` 延迟到下一帧并再次确认 CodeMirror 已结束组合，兼容 WebKitGTK 最后一批 DOM mutation 晚到的情况
4. 复制内容是 Markdown 原文，不是渲染后的视觉文本
5. Undo/redo 不受装饰影响
6. 只处理 `visibleRanges`，不对整篇文档跑遍历
7. 保存结果与关闭实时预览后看到的内容完全一致

第一版只支持 `.md`，不做 `.mdx`（JSX 节点、组件属性会显著增加复杂度）。

### 6.1 WebKitGTK 验收与长文档预算

- `pnpm test:e2e` 以 `e2e,custom-protocol` feature 构建独立的 `blog-editor-e2e` 测试二进制，在无 `DISPLAY` 的隔离 headless Wayland compositor 中，通过 `@wdio/tauri-service` 的嵌入式 WebDriver 驱动真实 WebKitGTK。用例覆盖自动打开项目、对话框初始焦点/Tab 环绕/Escape/焦点恢复、文章打开、实时/源码模式切换、键盘输入、删除线装饰、dirty 状态和保存；同时用 `wl-copy image/png` 设置真实 Wayland 剪贴板，再验证 Ctrl+V、Rust 原生读取、资产字节、内嵌图片与最终 Markdown 引用、中文组合开始时无关图片仍保持渲染，以及全流程没有 CSP violation。
- WebDriver 用例结束后复用同一个 debug 二进制，由 Sway IPC 向独立窗口发送真实 `xdg_toplevel.close` 并检查正常退出与生命周期日志，不增加第二轮编译。标签/手动发布构建改用 release 二进制执行这一步，并验证隔离 `XDG_DATA_HOME` 中的文件日志。
- `tauri-plugin-wdio-webdriver` 是 optional dependency，只在 `e2e` feature 下注册。正常开发与发布构建不包含测试 HTTP 自动化端点。
- E2E launcher 每次只把 `.blog-editor.json` 和受控的 `hello-astro.md` 复制到新建临时目录，Rust 侧自动打开项目的环境变量入口同样只在 `e2e` feature 存在；测试结束删除临时目录，不读写手测文章和真实博客。
- `livePreview.performance.test.ts` 预先完整解析约 1 MiB Markdown，再对约 4 KiB 可见区重复构建装饰；p95 必须低于 16 ms。完整语法树注入只服务可复现基准，生产插件仍直接使用 CodeMirror 的增量语法树。

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

项目设置面板只提交结构化 `ProjectConfig`，不接收任意文件路径或原始 JSON。打开项目与保存设置共用同一套 Rust 校验；保存前先完整验证，随后在项目根目录创建同权限临时文件、`sync_all` 并原子替换 `.blog-editor.json`，最后从磁盘重新加载到 `AppState`。写入时合并当前版本不认识的对象键，避免插件或未来版本的扩展配置被静默删除。

第一版允许编辑文章扩展名、预览命令/参数/端口/路由模板以及 Frontmatter 字段；`contentDir`、资产模式和固定监听地址 `127.0.0.1` 只读。配置保存成功后取消旧预览进程，当前文章编辑会话和未保存正文保持不变。

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
当前检查点：图片粘贴/拖拽（含 WebKitGTK 原生兜底）、待提交清理、标签索引、重命名资产改写、可恢复删除、项目配置 UI、保存屏障、关闭/草稿恢复，以及实时排版核心节点和结构化块（引用、列表、任务项、表格、删除线、自动链接、分隔线、Setext 标题）均已完成。实时排版第一版的语法范围至此闭环；真实 WebKitGTK 打开/输入/模式切换/保存 smoke 与 1 MiB 长文档可见区性能预算也已落地，不继续无边界扩展语法。

CI 在 GitHub Linux runner 的 `archlinux:base-devel` rolling 容器中安装 Arch 官方 `webkit2gtk-4.1`、Rust、Sway 和 `wl-clipboard`，执行 Biome、前端测试（含性能预算）/构建、`cargo fmt`、Clippy `-D warnings`、Rust 测试，最后由专用非 root 用户在 headless Sway 中执行原生 Wayland WebKitGTK E2E。测试显式清除 `DISPLAY` 并在 Sway 配置中关闭 XWayland，失败时不能回退到 X11；`tauri build --no-bundle` 及 release 文件日志验收只在版本标签或手动发布时执行。

Arch 安装包位于 `packaging/arch`：`makepkg -si` 构建跟踪 GitHub `main` 的 `blog-editor-git`，安装二进制、desktop entry 与 hicolor 图标，并由 `/usr/bin/blog-editor` 包装器强制 `GDK_BACKEND=wayland`。没有 `WAYLAND_DISPLAY` 时包装器直接给出错误，不尝试 X11/XWayland。Tauri 自带 bundle 已关闭；项目不生成 AppImage、deb 或 rpm。

**阶段 5：Obsidian 式实时预览**
ATX/Setext heading → strong → emphasis → strikethrough → inlineCode → link/autolink → fencedCode → image → horizontal rule → blockquote/list/task/table，IME/选区/复制/撤销测试作为验收的一部分，不是事后补充。

即使实时预览最后没按期完成，前四个阶段已经是一个完整可用的工具。
