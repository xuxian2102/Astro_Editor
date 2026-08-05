import {
  MapMode,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api, errorMessage } from "../lib/tauriApi";
import i18n from "../i18n";

export interface ImageInsertionRange {
  from: number;
  to: number;
}

export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_BATCH_COUNT = 20;

export function imageImportLimitError(
  files: ReadonlyArray<Pick<File, "name" | "size">>,
): string | null {
  if (files.length > MAX_IMAGE_BATCH_COUNT) {
    return i18n.t(($) => $.editor.imageImport.maxCount, {
      count: MAX_IMAGE_BATCH_COUNT,
    });
  }
  let total = 0;
  for (const file of files) {
    if (file.size <= 0) {
      return i18n.t(($) => $.editor.imageImport.emptyFile, {
        name: file.name,
      });
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      return i18n.t(($) => $.editor.imageImport.fileTooLarge, {
        name: file.name,
      });
    }
    total += file.size;
    if (total > MAX_IMAGE_BATCH_BYTES) {
      return i18n.t(($) => $.editor.imageImport.batchTooLarge);
    }
  }
  return null;
}

interface ImageInsertionAnchor {
  id: string;
  range: ImageInsertionRange;
}

const addImageInsertionAnchor = StateEffect.define<ImageInsertionAnchor>();
const removeImageInsertionAnchor = StateEffect.define<string>();

/**
 * 把异步图片任务的位置随每一次 CodeMirror ChangeSet 映射。非空选区内部一旦被用户
 * 改写就取消该锚点，绝不在 Promise 返回后拿旧 offset 删除用户的新文字。
 */
export function mapImageInsertionRange(
  range: ImageInsertionRange,
  changes: ChangeDesc,
): ImageInsertionRange | null {
  if (changes.empty) return range;

  if (range.from === range.to) {
    // 图片粘贴先发生：用户随后在同一点输入时，让图片留在这些新文字之前。
    const position = changes.mapPos(range.from, -1, MapMode.TrackDel);
    return position === null ? null : { from: position, to: position };
  }

  let targetWasEdited = false;
  changes.iterChangedRanges((from, to) => {
    if (from === to) {
      // 边界处输入不属于原选区；原选区内部输入则不应在图片完成后被删掉。
      if (from > range.from && from < range.to) targetWasEdited = true;
      return;
    }
    if (from < range.to && to > range.from) targetWasEdited = true;
  });
  if (targetWasEdited) return null;

  return {
    // 新文字恰好插在选区边界时排除在未来的替换范围之外。
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
  };
}

const imageInsertionAnchorField = StateField.define<
  ReadonlyMap<string, ImageInsertionRange>
>({
  create: () => new Map(),
  update(anchors, transaction) {
    const hasAnchorEffect = transaction.effects.some(
      (effect) =>
        effect.is(addImageInsertionAnchor) ||
        effect.is(removeImageInsertionAnchor),
    );
    if (transaction.changes.empty && !hasAnchorEffect) return anchors;

    const next = new Map<string, ImageInsertionRange>();
    for (const [id, range] of anchors) {
      const mapped = mapImageInsertionRange(range, transaction.changes);
      if (mapped) next.set(id, mapped);
    }
    for (const effect of transaction.effects) {
      if (effect.is(addImageInsertionAnchor)) {
        next.set(effect.value.id, effect.value.range);
      } else if (effect.is(removeImageInsertionAnchor)) {
        next.delete(effect.value);
      }
    }
    return next;
  },
});

/** MarkdownEditor 必须安装一次；锚点只存在 EditorState，不会写进 Markdown 原文。 */
export const imageInsertionAnchorExtension: Extension =
  imageInsertionAnchorField;

let nextImageInsertionId = 0;

function normalizedRange(
  view: EditorView,
  range: number | ImageInsertionRange,
): ImageInsertionRange {
  const input =
    typeof range === "number" ? { from: range, to: range } : range;
  const from = Math.max(0, Math.min(input.from, view.state.doc.length));
  const to = Math.max(from, Math.min(input.to, view.state.doc.length));
  return { from, to };
}

export function createImageInsertionAnchor(
  view: EditorView,
  range: number | ImageInsertionRange,
): string {
  nextImageInsertionId += 1;
  const id = `image-insertion-${nextImageInsertionId}`;
  view.dispatch({
    effects: addImageInsertionAnchor.of({
      id,
      range: normalizedRange(view, range),
    }),
  });
  return id;
}

export function cancelImageInsertionAnchor(
  view: EditorView,
  id: string,
): void {
  if (!view.state.field(imageInsertionAnchorField, false)?.has(id)) return;
  view.dispatch({ effects: removeImageInsertionAnchor.of(id) });
}

function imageInsertionRange(
  view: EditorView,
  id: string,
): ImageInsertionRange | null {
  return view.state.field(imageInsertionAnchorField, false)?.get(id) ?? null;
}

export function isPasteShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "repeat"
  >,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.repeat &&
    (event.code === "KeyV" || event.key.toLowerCase() === "v")
  );
}

const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|ico|jfif|jpe?g|png|svg|tiff?|webp)$/i;
const NATIVE_FILE_CLIPBOARD_TYPES = new Set([
  "files",
  "text/uri-list",
  "x-special/gnome-copied-files",
  "application/x-kde4-urilist",
  "application/vnd.portal.filetransfer",
]);

function isImageFile(file: File): boolean {
  // 有些 Linux 文件管理器拖进来的 File 不带 MIME type，只能再看扩展名。
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

/**
 * ClipboardEvent 的图片通常在 items 里，文件管理器复制的图片也可能只出现在 files 里。
 * 优先 items，避免同一个 File 在两个列表里被重复导入。
 */
export function extractPastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];

  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;

  return Array.from(data.files ?? []).filter(isImageFile);
}

/** WebKit 可能只暴露“复制了文件”的 MIME，而不肯把图片放进 files/items。 */
export function hasNativeImageClipboardHint(
  data: DataTransfer | null,
): boolean {
  if (!data) return false;
  const types = [
    ...Array.from(data.types ?? []),
    ...Array.from(data.items ?? []).map((item) => item.type),
  ];
  return types.some((type) => {
    const normalized = type.toLowerCase();
    return (
      normalized.startsWith("image/") ||
      NATIVE_FILE_CLIPBOARD_TYPES.has(normalized)
    );
  });
}

function hasNativeFileClipboardHint(data: DataTransfer): boolean {
  return [
    ...Array.from(data.types ?? []),
    ...Array.from(data.items ?? []).map((item) => item.type),
  ].some((type) => NATIVE_FILE_CLIPBOARD_TYPES.has(type.toLowerCase()));
}

/**
 * WebKitGTK 旧版本会派发 paste 事件，但把图片的 DataTransfer 清空。只有这种情况，
 * 或者明明声明了 image/* 却拿不到 File 时，才需要走 Tauri 原生剪贴板兜底；普通文本
 * 粘贴继续交给 CodeMirror，保持多光标、撤销和换行等原生语义。
 */
export function needsNativeClipboardFallback(
  data: DataTransfer | null,
): boolean {
  if (!data) return true;
  const items = Array.from(data.items ?? []);
  const files = Array.from(data.files ?? []);
  if (items.length === 0 && files.length === 0) return true;
  if (hasNativeFileClipboardHint(data)) return true;
  return items.some(
    (item) => item.type.startsWith("image/") && item.getAsFile() === null,
  );
}

export function markdownImageReference(relPath: string): string {
  // Markdown 的裸链接目标不能安全容纳空格、括号、#、? 等文件名字符。
  const url = relPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `![](${url})\n`;
}

export function markdownImageReferences(relPaths: string[]): string {
  return relPaths.map(markdownImageReference).join("");
}

function insertReferencesAtAnchor(
  view: EditorView,
  relPaths: string[],
  anchorId: string,
  keepAnchor: boolean,
): boolean {
  if (relPaths.length === 0) return false;
  const range = imageInsertionRange(view, anchorId);
  if (!range) return false;
  const insertText = markdownImageReferences(relPaths);
  const { from, to } = range;
  view.dispatch({
    changes: { from, to, insert: insertText },
    selection: { anchor: from + insertText.length },
    scrollIntoView: true,
    effects: removeImageInsertionAnchor.of(anchorId),
  });
  if (keepAnchor) {
    view.dispatch({
      effects: addImageInsertionAnchor.of({
        id: anchorId,
        range: {
          from: from + insertText.length,
          to: from + insertText.length,
        },
      }),
    });
  }
  return true;
}

/** 把已经拿到字节的一张图片存盘，再按当前映射后的锚点插入 Markdown 引用。 */
async function saveAndInsertAtAnchor(
  view: EditorView,
  projectGeneration: number,
  postId: string,
  suggestedName: string | null,
  bytes: Uint8Array,
  anchorId: string,
  isActive: () => boolean,
): Promise<boolean> {
  if (!isActive() || !imageInsertionRange(view, anchorId)) return false;
  const { markdownPath } = await api.saveImage(
    projectGeneration,
    postId,
    suggestedName,
    bytes,
  );
  if (!isActive()) return false;
  return insertReferencesAtAnchor(view, [markdownPath], anchorId, true);
}

/**
 * 依次保存并插入多张（拖拽的）图片文件，每一张都用上一张实际插入后的位置作为起点——
 * save_image 是异步调用，并发触发会导致后插入的图片拿着过期的文档位置，插到错地方。
 */
export async function insertImagesSequentially(
  view: EditorView,
  projectGeneration: number,
  postId: string,
  files: File[],
  start: number | ImageInsertionRange,
  onError: (message: string) => void,
  preserveFileNames = true,
  isActive: () => boolean = () => true,
): Promise<void> {
  const limitError = imageImportLimitError(files);
  if (limitError) {
    onError(limitError);
    return;
  }
  const anchorId = createImageInsertionAnchor(view, start);
  try {
    for (const file of files) {
      if (!isActive()) break;
      if (!imageInsertionRange(view, anchorId)) {
        onError(i18n.t(($) => $.editor.imageImport.anchorChanged));
        break;
      }
      try {
        const buffer = await file.arrayBuffer();
        if (!isActive()) break;
        if (!imageInsertionRange(view, anchorId)) {
          onError(i18n.t(($) => $.editor.imageImport.anchorChanged));
          break;
        }
        if (buffer.byteLength > MAX_IMAGE_FILE_BYTES) {
          onError(
            i18n.t(($) => $.editor.imageImport.fileTooLarge, {
              name: file.name,
            }),
          );
          break;
        }
        const bytes = new Uint8Array(buffer);
        const inserted = await saveAndInsertAtAnchor(
          view,
          projectGeneration,
          postId,
          preserveFileNames ? file.name : null,
          bytes,
          anchorId,
          isActive,
        );
        if (!inserted) {
          onError(i18n.t(($) => $.editor.imageImport.anchorChangedAfterRead));
          break;
        }
      } catch (e) {
        onError(errorMessage(e));
      }
    }
  } finally {
    if (isActive()) cancelImageInsertionAnchor(view, anchorId);
  }
}

export function extractDroppedImages(data: DataTransfer | null): File[] {
  const files = data?.files;
  if (!files) return [];
  return Array.from(files).filter(isImageFile);
}

/**
 * WebKitGTK 有个已知 bug（WebKit bug 218519）：Linux 上粘贴图片时
 * ClipboardEvent.clipboardData 里的图片数据是空的/取不到，浏览器标准剪贴板 API
 * 完全没法用。这里调用应用自己的 Rust 命令，绕开 WebKit；原生侧同时兼容
 * Wayland 的多种 image/* MIME 和文件管理器复制的图片路径。
 *
 * 调用方只会在 paste 事件明确表现为“图片数据被 WebKit 隐藏”时进入这里，因此读取
 * 失败必须反馈，不能像普通文本粘贴一样静默吞掉，否则用户只会看到粘贴毫无反应。
 */
export async function insertClipboardImageIfPresent(
  view: EditorView,
  projectGeneration: number,
  postId: string,
  range: ImageInsertionRange,
  onError: (message: string) => void,
  reportMissingImage = true,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  const anchorId = createImageInsertionAnchor(view, range);
  try {
    return await insertClipboardImagesAtAnchor(
      view,
      projectGeneration,
      postId,
      anchorId,
      onError,
      reportMissingImage,
      isActive,
    );
  } finally {
    if (isActive()) cancelImageInsertionAnchor(view, anchorId);
  }
}

/** 已在键盘事件中建立锚点时使用，避免 80ms WebKit 兜底定时器重新采用旧 offset。 */
export async function insertClipboardImagesAtAnchor(
  view: EditorView,
  projectGeneration: number,
  postId: string,
  anchorId: string,
  onError: (message: string) => void,
  reportMissingImage = true,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  try {
    const images = await api.importClipboardImages(projectGeneration, postId);
    if (!isActive()) return false;
    const inserted = insertReferencesAtAnchor(
      view,
      images.map((image) => image.markdownPath),
      anchorId,
      false,
    );
    if (!inserted && reportMissingImage && images.length > 0) {
      onError(i18n.t(($) => $.editor.imageImport.anchorChangedAfterRead));
    }
    return inserted;
  } catch (e) {
    if (reportMissingImage) onError(errorMessage(e));
    return false;
  }
}
