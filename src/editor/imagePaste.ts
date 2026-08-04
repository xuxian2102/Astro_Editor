import type { EditorView } from "@codemirror/view";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorMessage } from "../lib/tauriApi";

/** 把已经拿到字节的一张图片存盘并在指定位置插入 Markdown 引用，返回插入后的新位置 */
async function saveAndInsertAt(
  view: EditorView,
  postId: string,
  suggestedName: string | null,
  bytes: number[],
  pos: number,
): Promise<number> {
  const relPath = await api.saveImage(postId, suggestedName, bytes);
  const insertText = `![](${relPath})\n`;
  const from = Math.min(pos, view.state.doc.length);
  view.dispatch({
    changes: { from, insert: insertText },
    selection: { anchor: from + insertText.length },
  });
  return from + insertText.length;
}

/**
 * 依次保存并插入多张（拖拽的）图片文件，每一张都用上一张实际插入后的位置作为起点——
 * save_image 是异步调用，并发触发会导致后插入的图片拿着过期的文档位置，插到错地方。
 */
export async function insertImagesSequentially(
  view: EditorView,
  postId: string,
  files: File[],
  startPos: number,
  onError: (message: string) => void,
): Promise<void> {
  let pos = startPos;
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      pos = await saveAndInsertAt(view, postId, file.name, bytes, pos);
    } catch (e) {
      onError(errorMessage(e));
    }
  }
}

export function extractDroppedImages(data: DataTransfer | null): File[] {
  const files = data?.files;
  if (!files) return [];
  return Array.from(files).filter((f) => f.type.startsWith("image/"));
}

/**
 * 把剪贴板里的原始 RGBA 像素编码成 PNG 字节。readImage() 拿到的是未压缩的位图，
 * 不是现成的图片文件——用 canvas 编一次码，不需要额外的图片处理依赖。
 */
async function rgbaToPngBytes(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<number[]> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 2d context");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("PNG 编码失败");
  const buffer = await blob.arrayBuffer();
  return Array.from(new Uint8Array(buffer));
}

/**
 * WebKitGTK 有个已知 bug（WebKit bug 218519）：Linux 上粘贴图片时
 * ClipboardEvent.clipboardData 里的图片数据是空的/取不到，浏览器标准剪贴板 API
 * 完全没法用。这里绕开它，改用 Tauri 的 clipboard-manager 插件——它在 Rust 侧
 * 通过 arboard 直接读系统剪贴板，不经过 WebKit 那层坏掉的 JS API。
 *
 * 剪贴板没有图片时 readImage() 会 reject，正常吞掉即可，交给编辑器默认的文本粘贴处理。
 */
export async function insertClipboardImageIfPresent(
  view: EditorView,
  postId: string,
  pos: number,
  onError: (message: string) => void,
): Promise<void> {
  let image;
  try {
    image = await readImage();
  } catch {
    return; // 剪贴板里没有图片
  }
  try {
    const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
    const bytes = await rgbaToPngBytes(rgba, size.width, size.height);
    await saveAndInsertAt(view, postId, null, bytes, pos);
  } catch (e) {
    onError(errorMessage(e));
  }
}
