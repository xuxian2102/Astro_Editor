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
  extractPastedImage,
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
          paste(event, view) {
            const file = extractPastedImage(event.clipboardData);
            if (!file) return false;
            event.preventDefault();
            const pos = view.state.selection.main.head;
            void insertImagesSequentially(
              view,
              postIdRef.current,
              [{ file, suggestedName: null }],
              pos,
              onImageErrorRef.current,
            );
            return true;
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
              images.map((file) => ({ file, suggestedName: file.name })),
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
