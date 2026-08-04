import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  extractDroppedImages,
  insertClipboardImageIfPresent,
  insertImagesSequentially,
} from "./imagePaste";

interface MarkdownEditorProps {
  /** 变化时整个重建编辑器状态（换文章 / 外部重载） */
  sessionKey: string;
  postId: string;
  initialBody: string;
  onChange: (body: string) => void;
  onSave: () => void;
  onImageError: (message: string) => void;
}

/** 基础 CodeMirror 6，阶段 5 才引入实时预览 ViewPlugin */
export default function MarkdownEditor({
  sessionKey,
  postId,
  initialBody,
  onChange,
  onSave,
  onImageError,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialBodyRef = useRef(initialBody);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const postIdRef = useRef(postId);
  const onImageErrorRef = useRef(onImageError);
  initialBodyRef.current = initialBody;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  postIdRef.current = postId;
  onImageErrorRef.current = onImageError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = EditorState.create({
      doc: initialBodyRef.current,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        placeholder("开始写作…"),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          // WebKitGTK 的 ClipboardEvent.clipboardData 读不到图片（WebKit bug 218519），
          // 所以图片粘贴不走 paste 事件，改成在按键时用原生剪贴板插件主动查一次。
          // 这里始终不拦截默认行为——剪贴板没有图片时让 CodeMirror 自己处理文本粘贴。
          keydown(event, view) {
            if ((event.ctrlKey || event.metaKey) && event.key === "v") {
              const pos = view.state.selection.main.head;
              void insertClipboardImageIfPresent(
                view,
                postIdRef.current,
                pos,
                onImageErrorRef.current,
              );
            }
            return false;
          },
          drop(event, view) {
            const images = extractDroppedImages(event.dataTransfer);
            if (images.length === 0) return false;
            event.preventDefault();
            const coords = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            const pos = coords ?? view.state.selection.main.head;
            void insertImagesSequentially(
              view,
              postIdRef.current,
              images,
              pos,
              onImageErrorRef.current,
            );
            return true;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: container });
    return () => view.destroy();
  }, [sessionKey]);

  return <div ref={containerRef} className="editor-host" />;
}
