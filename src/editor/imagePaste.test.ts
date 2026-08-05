import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  extractDroppedImages,
  extractPastedImages,
  hasNativeImageClipboardHint,
  imageImportLimitError,
  isPasteShortcut,
  mapImageInsertionRange,
  markdownImageReference,
  markdownImageReferences,
  needsNativeClipboardFallback,
} from "./imagePaste";

function file(name: string, type: string): File {
  return { name, type } as File;
}

function item(
  type: string,
  value: File | null,
  kind: DataTransferItem["kind"] = "file",
): DataTransferItem {
  return { kind, type, getAsFile: () => value } as DataTransferItem;
}

function transfer(
  items: DataTransferItem[] = [],
  files: File[] = [],
  types: string[] = items.map(({ type }) => type),
): DataTransfer {
  return { items, files, types } as unknown as DataTransfer;
}

describe("extractPastedImages", () => {
  it("从 clipboard items 提取图片，并避免再从 files 重复提取", () => {
    const pasted = file("clipboard.png", "image/png");
    const duplicate = file("clipboard.png", "image/png");
    expect(
      extractPastedImages(transfer([item("image/png", pasted)], [duplicate])),
    ).toEqual([pasted]);
  });

  it("兼容没有 MIME type、但扩展名是图片的文件管理器数据", () => {
    const photo = file("旅行照片.WEBP", "");
    const note = file("note.txt", "");
    const data = transfer([], [photo, note]);
    expect(extractPastedImages(data)).toEqual([photo]);
    expect(extractDroppedImages(data)).toEqual([photo]);
  });
});

describe("isPasteShortcut", () => {
  const keyboard = (
    overrides: Partial<
      Pick<
        KeyboardEvent,
        "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "repeat"
      >
    >,
  ) =>
    ({
      altKey: false,
      code: "KeyV",
      ctrlKey: false,
      key: "v",
      metaKey: false,
      repeat: false,
      ...overrides,
    }) as Pick<
      KeyboardEvent,
      "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "repeat"
    >;

  it("识别 Ctrl+V 和 macOS Cmd+V", () => {
    expect(isPasteShortcut(keyboard({ ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(keyboard({ metaKey: true }))).toBe(true);
  });

  it("不拦截 Alt 组合、按键长按或普通 V", () => {
    expect(isPasteShortcut(keyboard({ ctrlKey: true, altKey: true }))).toBe(
      false,
    );
    expect(isPasteShortcut(keyboard({ ctrlKey: true, repeat: true }))).toBe(
      false,
    );
    expect(isPasteShortcut(keyboard({}))).toBe(false);
  });
});

describe("needsNativeClipboardFallback", () => {
  it("WebKitGTK 把 DataTransfer 清空时启用原生剪贴板", () => {
    expect(needsNativeClipboardFallback(null)).toBe(true);
    expect(needsNativeClipboardFallback(transfer())).toBe(true);
  });

  it("图片类型存在但 WebKit 拿不到 File 时启用原生剪贴板", () => {
    expect(
      needsNativeClipboardFallback(transfer([item("image/png", null)])),
    ).toBe(true);
  });

  it("文件管理器只暴露 URI/portal MIME 时也走原生图片导入", () => {
    const uriList = transfer([], [], ["text/uri-list"]);
    const portal = transfer([], [], ["application/vnd.portal.filetransfer"]);
    expect(hasNativeImageClipboardHint(uriList)).toBe(true);
    expect(needsNativeClipboardFallback(uriList)).toBe(true);
    expect(needsNativeClipboardFallback(portal)).toBe(true);
  });

  it("普通文本和可读取图片不需要原生兜底", () => {
    expect(
      needsNativeClipboardFallback(
        transfer([item("text/plain", null, "string")]),
      ),
    ).toBe(false);
    expect(
      needsNativeClipboardFallback(
        transfer([item("image/png", file("image.png", "image/png"))]),
      ),
    ).toBe(false);
  });
});

describe("markdownImageReference", () => {
  it("编码会破坏 Markdown 链接解析的文件名字符", () => {
    expect(markdownImageReference("post/封面 (最终版)#1.png")).toBe(
      "![](post/%E5%B0%81%E9%9D%A2%20%28%E6%9C%80%E7%BB%88%E7%89%88%29%231.png)\n",
    );
  });

  it("一次原生导入多张图片时按剪贴板顺序生成引用", () => {
    expect(markdownImageReferences(["post/a.png", "post/b.webp"])).toBe(
      "![](post/a.png)\n![](post/b.webp)\n",
    );
  });
});

describe("异步图片插入锚点", () => {
  const changes = (change: { from: number; to?: number; insert?: string }) =>
    EditorState.create({ doc: "abcdef" }).update({ changes: change }).changes;

  it("用户在目标之前输入时，锚点随 ChangeSet 后移", () => {
    expect(
      mapImageInsertionRange(
        { from: 2, to: 4 },
        changes({ from: 0, insert: "XX" }),
      ),
    ).toEqual({ from: 4, to: 6 });
  });

  it("光标锚点与同位置后续输入保持确定顺序", () => {
    expect(
      mapImageInsertionRange(
        { from: 2, to: 2 },
        changes({ from: 2, insert: "XX" }),
      ),
    ).toEqual({ from: 2, to: 2 });
  });

  it("选区内部被编辑或覆盖后取消锚点，避免删除新文字", () => {
    expect(
      mapImageInsertionRange(
        { from: 2, to: 4 },
        changes({ from: 3, insert: "XX" }),
      ),
    ).toBeNull();
    expect(
      mapImageInsertionRange(
        { from: 2, to: 4 },
        changes({ from: 2, to: 4, insert: "replacement" }),
      ),
    ).toBeNull();
  });

  it("选区边界处的新输入不会被未来图片替换吞掉", () => {
    expect(
      mapImageInsertionRange(
        { from: 2, to: 4 },
        changes({ from: 2, insert: "XX" }),
      ),
    ).toEqual({ from: 4, to: 6 });
    expect(
      mapImageInsertionRange(
        { from: 2, to: 4 },
        changes({ from: 4, insert: "XX" }),
      ),
    ).toEqual({ from: 2, to: 4 });
  });
});

describe("图片导入限制", () => {
  const sized = (name: string, size: number) => ({ name, size });

  it("接受限制内的批量图片", () => {
    expect(
      imageImportLimitError([
        sized("a.png", 1024),
        sized("b.jpg", 2 * 1024 * 1024),
      ]),
    ).toBeNull();
  });

  it("拒绝空文件、超大单图、过多文件和过大批次", () => {
    expect(imageImportLimitError([sized("empty.png", 0)])).toContain("为空");
    expect(
      imageImportLimitError([sized("huge.png", 25 * 1024 * 1024 + 1)]),
    ).toContain("25 MiB");
    expect(
      imageImportLimitError(
        Array.from({ length: 21 }, (_, index) => sized(`${index}.png`, 1)),
      ),
    ).toContain("20 张");
    expect(
      imageImportLimitError(
        Array.from({ length: 5 }, (_, index) =>
          sized(`${index}.png`, 21 * 1024 * 1024),
        ),
      ),
    ).toContain("100 MiB");
  });
});
