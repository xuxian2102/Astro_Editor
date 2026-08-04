import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const marker = "E2E-WEBKITGTK-SMOKE";
const arrowUp = "\uE013";

async function waitForDom(description, check) {
  try {
    await browser.waitUntil(
      async () => Boolean(await browser.execute(check)),
      { timeout: 10_000, interval: 50, timeoutMsg: description },
    );
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
  it("opens, renders, edits, toggles source mode, and saves a real post", async () => {
    // 显式确认当前窗口，阻止 service 尝试调用未安装、也不需要的高权限 WDIO
    // Tauri 插件做自动聚焦；后续仍由嵌入式 WebDriver 驱动当前 WebKitGTK。
    const windowHandle = await browser.getWindowHandle();
    await browser.switchToWindow(windowHandle);

    await waitForDom(
      "隔离项目没有在 WebKitGTK 中自动打开",
      () => document.querySelector(".project-name") !== null,
    );

    const opened = await browser.execute(() => {
      const post = [...document.querySelectorAll("button.post-open")].find(
        (button) => button.textContent?.trim() === "hello-astro.md",
      );
      if (!(post instanceof HTMLElement)) return false;
      post.click();
      return true;
    });
    assert.equal(opened, true, "文章列表里缺少 hello-astro.md");

    await waitForDom(
      "文章没有在 WebKitGTK 中打开",
      () => document.querySelector(".doc-title")?.textContent?.includes("hello-astro.md"),
    );
    await waitForDom(
      "CodeMirror 没有挂载",
      () => document.querySelector(".editor-host .cm-editor") !== null,
    );
    await waitForDom(
      "ATX 标题实时装饰没有渲染",
      () => document.querySelector(".cm-line.cm-live-heading-1") !== null,
    );
    await waitForDom(
      "代码块语言 Widget 没有渲染",
      () => document.querySelector(".cm-live-code-language") !== null,
    );

    const modeInitiallyEnabled = await browser.execute(
      () => document.querySelector("button.editor-mode-toggle")?.getAttribute("aria-pressed"),
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
    await waitForDom(
      "真实键盘输入没有进入 CodeMirror",
      () => document.querySelector(".cm-content")?.textContent?.includes("E2E-WEBKITGTK-SMOKE"),
    );
    await browser.keys(Array.from({ length: 20 }, () => arrowUp));
    await waitForDom(
      "删除线装饰没有在光标离开后生成",
      () => document.querySelector(".cm-live-strikethrough")?.textContent === "E2E-WEBKITGTK-SMOKE",
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
  });
});
