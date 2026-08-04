import type { EditorView } from "@codemirror/view";
import { api, errorMessage } from "../lib/tauriApi";

async function uploadImage(
  postId: string,
  file: File,
  suggestedName: string | null,
): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  return api.saveImage(postId, suggestedName, bytes);
}

/**
 * 依次保存并插入多张图片，每一张都用上一张实际插入后的位置作为起点——
 * save_image 是异步调用，并发触发会导致后插入的图片拿着过期的文档位置，插到错地方。
 */
export async function insertImagesSequentially(
  view: EditorView,
  postId: string,
  files: { file: File; suggestedName: string | null }[],
  startPos: number,
  onError: (message: string) => void,
): Promise<void> {
  let pos = startPos;
  for (const { file, suggestedName } of files) {
    try {
      const relPath = await uploadImage(postId, file, suggestedName);
      const insertText = `![](${relPath})\n`;
      const from = Math.min(pos, view.state.doc.length);
      view.dispatch({
        changes: { from, insert: insertText },
        selection: { anchor: from + insertText.length },
      });
      pos = from + insertText.length;
    } catch (e) {
      onError(errorMessage(e));
    }
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** 剪贴板只处理第一个图片项——浏览器剪贴板通常也只会放一个 */
export function extractPastedImage(data: DataTransfer | null): File | null {
  const items = data?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function extractDroppedImages(data: DataTransfer | null): File[] {
  const files = data?.files;
  if (!files) return [];
  return Array.from(files).filter(isImageFile);
}
