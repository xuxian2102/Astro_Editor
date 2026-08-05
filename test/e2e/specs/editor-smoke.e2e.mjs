import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const marker = "E2E-WEBKITGTK-SMOKE";
const arrowUp = "\uE013";
const control = "\uE009";
const enter = "\uE007";
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const clipboardFixture = join(workspaceRoot, "src-tauri/icons/32x32.png");

function copyWaylandImage(bytes) {
  const { DISPLAY: _display, ...waylandEnvironment } = process.env;
  const copied = spawnSync("wl-copy", ["--type", "image/png"], {
    env: waylandEnvironment,
    input: bytes,
    // wl-copy 默认 fork 一个后台 provider；输出若仍是 pipe，Node 会等待后台
    // 进程关闭描述符而永久阻塞。丢弃其输出后只等待负责 fork 的父进程。
    stdio: ["pipe", "ignore", "ignore"],
  });
  assert.equal(
    copied.status,
    0,
    `wl-copy 无法写入隔离 Wayland 剪贴板：${copied.error ?? "未知错误"}`,
  );
  const advertised = spawnSync("wl-paste", ["--list-types"], {
    env: waylandEnvironment,
    encoding: "utf8",
  });
  assert.equal(
    advertised.status,
    0,
    `wl-paste 无法读取隔离 Wayland 剪贴板：${advertised.stderr}`,
  );
  assert.match(advertised.stdout, /^image\/png$/m);
}

async function waitForDom(description, check) {
  try {
    await browser.waitUntil(async () => Boolean(await browser.execute(check)), {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: description,
    });
  } catch (error) {
    const snapshot = await browser.execute(() => ({
      href: window.location.href,
      title: document.title,
      body: document.body?.innerText ?? "",
      html: document.documentElement?.outerHTML.slice(0, 2_000) ?? "",
    }));
    throw new Error(
      `${description}\nWebKitGTK 页面快照：${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
}

async function click(selector) {
  const clicked = await browser.execute((target) => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `找不到可点击元素：${selector}`);
}

describe("WebKitGTK editor smoke", () => {
  it("edits, toggles source mode, pastes a Wayland image, and saves", async () => {
    // 显式确认当前窗口，阻止 service 尝试调用未安装、也不需要的高权限 WDIO
    // Tauri 插件做自动聚焦；后续仍由嵌入式 WebDriver 驱动当前 WebKitGTK。
    const windowHandle = await browser.getWindowHandle();
    await browser.switchToWindow(windowHandle);
    await browser.execute(() => {
      window.__blogEditorE2eCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__blogEditorE2eCspViolations.push({
          blockedUri: event.blockedURI,
          directive: event.effectiveDirective,
        });
      });
    });

    await waitForDom(
      "隔离项目没有在 WebKitGTK 中自动打开",
      () => document.querySelector(".project-name") !== null,
    );

    const settingsOpened = await browser.execute(() => {
      const trigger = document.querySelector('button[aria-haspopup="dialog"]');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.focus();
      trigger.click();
      return true;
    });
    assert.equal(settingsOpened, true, "找不到项目设置按钮");
    await waitForDom(
      "项目设置没有把初始焦点移入标题",
      () => document.activeElement?.id === "project-settings-title",
    );
    const settingsAccessibility = await browser.execute(() => {
      const dialog = document.querySelector(".settings-modal");
      if (!(dialog instanceof HTMLElement)) return null;
      const titleId = dialog.getAttribute("aria-labelledby");
      const descriptionIds =
        dialog.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      return {
        modal: dialog.getAttribute("aria-modal"),
        titleExists: Boolean(titleId && document.getElementById(titleId)),
        descriptionsExist: descriptionIds.every((id) =>
          Boolean(document.getElementById(id)),
        ),
      };
    });
    assert.deepEqual(settingsAccessibility, {
      modal: "true",
      titleExists: true,
      descriptionsExist: true,
    });
    await browser.execute(() => {
      document
        .querySelector(".settings-modal")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    await waitForDom(
      "Escape 没有关闭项目设置并把焦点还给触发按钮",
      () =>
        document.querySelector(".settings-modal") === null &&
        document.activeElement?.getAttribute("aria-haspopup") === "dialog",
    );

    await click(".sidebar-actions button");
    const createInput = await $(".sidebar-actions .inline-input");
    await createInput.setValue("hello-astro.md");
    await browser.keys(enter);
    await waitForDom("结构化 Rust 错误没有经前端文案目录显示", () =>
      document
        .querySelector(".error-banner")
        ?.textContent?.includes("目标已存在：hello-astro.md"),
    );
    await click(".error-banner button");

    const opened = await browser.execute(() => {
      const post = [...document.querySelectorAll("button.post-open")].find(
        (button) => button.textContent?.trim() === "hello-astro.md",
      );
      if (!(post instanceof HTMLElement)) return false;
      post.click();
      return true;
    });
    assert.equal(opened, true, "文章列表里缺少 hello-astro.md");

    await waitForDom("文章没有在 WebKitGTK 中打开", () =>
      document
        .querySelector(".doc-title")
        ?.textContent?.includes("hello-astro.md"),
    );
    await waitForDom(
      "CodeMirror 没有挂载",
      () => document.querySelector(".editor-host .cm-editor") !== null,
    );

    const deleteDialogOpened = await browser.execute(() => {
      const trigger = document.querySelector("button.post-delete");
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.focus();
      trigger.click();
      return true;
    });
    assert.equal(deleteDialogOpened, true, "找不到文章删除按钮");
    await waitForDom(
      "删除确认框没有把焦点移到取消按钮",
      () =>
        document.activeElement ===
        document.querySelector(".modal-actions button:first-child"),
    );
    const modalAccessibility = await browser.execute(() => {
      const dialog = document.querySelector(".modal");
      if (!(dialog instanceof HTMLElement)) return null;
      const titleId = dialog.getAttribute("aria-labelledby");
      const messageId = dialog.getAttribute("aria-describedby");
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      );
      return {
        modal: dialog.getAttribute("aria-modal"),
        titleExists: Boolean(titleId && document.getElementById(titleId)),
        messageExists: Boolean(messageId && document.getElementById(messageId)),
        wrappedBackward:
          document.activeElement ===
          document.querySelector(".modal-actions button:last-child"),
      };
    });
    assert.deepEqual(modalAccessibility, {
      modal: "true",
      titleExists: true,
      messageExists: true,
      wrappedBackward: true,
    });
    await browser.execute(() => {
      document
        .querySelector(".modal")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    await waitForDom(
      "Escape 没有关闭删除确认框并恢复触发按钮焦点",
      () =>
        document.querySelector(".modal") === null &&
        document.activeElement?.classList.contains("post-delete"),
    );
    await waitForDom(
      "ATX 标题实时装饰没有渲染",
      () => document.querySelector(".cm-line.cm-live-heading-1") !== null,
    );
    await waitForDom(
      "代码块语言 Widget 没有渲染",
      () => document.querySelector(".cm-live-code-language") !== null,
    );

    const modeInitiallyEnabled = await browser.execute(() =>
      document
        .querySelector("button.editor-mode-toggle")
        ?.getAttribute("aria-pressed"),
    );
    assert.equal(modeInitiallyEnabled, "true");
    await click("button.editor-mode-toggle");
    await waitForDom(
      "关闭实时排版后仍存在 heading 装饰",
      () => document.querySelectorAll(".cm-line.cm-live-heading").length === 0,
    );
    const sourceState = await browser.execute(() => ({
      pressed: document
        .querySelector("button.editor-mode-toggle")
        ?.getAttribute("aria-pressed"),
      text: document.querySelector(".cm-content")?.textContent ?? "",
    }));
    assert.equal(sourceState.pressed, "false");
    assert.match(sourceState.text, /# 你好，Astro/);

    await click("button.editor-mode-toggle");
    await waitForDom(
      "重新开启实时排版后标题装饰没有恢复",
      () => document.querySelector(".cm-line.cm-live-heading-1") !== null,
    );

    const focused = await browser.execute(() => {
      const editor = document.querySelector(".cm-content");
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.activeElement === editor;
    });
    assert.equal(focused, true, "CodeMirror 无法获得键盘焦点");
    const editorElement = await $(".cm-content");
    await editorElement.addValue(`\n\n~~${marker}~~`);
    await waitForDom("真实键盘输入没有进入 CodeMirror", () =>
      document
        .querySelector(".cm-content")
        ?.textContent?.includes("E2E-WEBKITGTK-SMOKE"),
    );
    await browser.keys(Array.from({ length: 20 }, () => arrowUp));
    await waitForDom(
      "删除线装饰没有在光标离开后生成",
      () =>
        document.querySelector(".cm-live-strikethrough")?.textContent ===
        "E2E-WEBKITGTK-SMOKE",
    );
    await waitForDom(
      "编辑后没有进入 dirty 状态",
      () => document.querySelector(".dirty-dot") !== null,
    );

    await click("button.btn-primary");
    await waitForDom(
      "保存完成后 dirty 状态没有清除",
      () => document.querySelector(".dirty-dot") === null,
    );

    const savedPath = join(
      process.env.BLOG_EDITOR_E2E_PROJECT,
      "src/content/blog/hello-astro.md",
    );
    await browser.waitUntil(
      async () => (await readFile(savedPath, "utf8")).includes(marker),
      { timeoutMsg: "Rust 后端没有把 WebKitGTK 输入原子写入临时文章" },
    );

    const clipboardBytes = await readFile(clipboardFixture);
    copyWaylandImage(clipboardBytes);
    const imageInsertionFocused = await browser.execute(() => {
      const editor = document.querySelector(".cm-content");
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.activeElement === editor;
    });
    assert.equal(imageInsertionFocused, true, "图片粘贴前编辑器无法获得焦点");
    await browser
      .action("key")
      .down(control)
      .down("v")
      .up("v")
      .up(control)
      .perform();

    await waitForDom(
      "Wayland 图片 Ctrl+V 后没有生成可用的实时预览",
      () => document.querySelector(".cm-live-image-ready img") !== null,
    );
    await waitForDom(
      "Wayland 图片粘贴后没有进入 dirty 状态",
      () => document.querySelector(".dirty-dot") !== null,
    );

    const assetDirectory = join(
      process.env.BLOG_EDITOR_E2E_PROJECT,
      "src/content/blog/hello-astro",
    );
    let importedImageName = "";
    await browser.waitUntil(
      async () => {
        try {
          const entries = (await readdir(assetDirectory)).filter((entry) =>
            entry.endsWith(".png"),
          );
          if (entries.length !== 1) return false;
          importedImageName = entries[0];
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMsg: "Rust 原生 Wayland 剪贴板没有创建图片资产" },
    );
    assert.match(importedImageName, /^[0-9a-f]{8}\.png$/);
    const importedBytes = await readFile(
      join(assetDirectory, importedImageName),
    );
    assert.deepEqual(importedBytes, clipboardBytes);

    await click("button.btn-primary");
    await waitForDom(
      "图片保存完成后 dirty 状态没有清除",
      () => document.querySelector(".dirty-dot") === null,
    );
    await browser.waitUntil(
      async () =>
        (await readFile(savedPath, "utf8")).includes(
          `![](hello-astro/${importedImageName})`,
        ),
      { timeoutMsg: "保存后的 Markdown 没有引用 Wayland 剪贴板图片" },
    );

    const compositionStarted = await browser.execute(() => {
      const editor = document.querySelector(".cm-content");
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      editor.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "中",
        }),
      );
      return true;
    });
    assert.equal(
      compositionStarted,
      true,
      "无法触发 WebKitGTK compositionstart",
    );
    await waitForDom(
      "在其他文本位置开始中文输入时，已渲染图片错误地退回 Markdown 源码",
      () => document.querySelector(".cm-live-image-ready img") !== null,
    );
    await browser.execute(() => {
      const editor = document.querySelector(".cm-content");
      editor?.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "中",
        }),
      );
    });

    const cspViolations = await browser.execute(
      () => window.__blogEditorE2eCspViolations,
    );
    assert.deepEqual(cspViolations, [], "生产 CSP 阻断了编辑器需要的资源");
  });
});
