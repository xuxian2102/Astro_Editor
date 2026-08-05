import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
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
  cancelImageInsertionAnchor,
  createImageInsertionAnchor,
  extractDroppedImages,
  extractPastedImages,
  hasNativeImageClipboardHint,
  imageInsertionAnchorExtension,
  insertClipboardImageIfPresent,
  insertClipboardImagesAtAnchor,
  insertImagesSequentially,
  isPasteShortcut,
  needsNativeClipboardFallback,
} from "./imagePaste";
import { api } from "../lib/tauriApi";
import i18n from "../i18n";
import {
  createLivePreviewExtension,
  imageMimeType,
} from "./livePreview";

interface MarkdownEditorProps {
  /** 变化时整个重建编辑器状态（换文章 / 外部重载） */
  sessionKey: string;
  postId: string;
  projectGeneration: number;
  initialBody: string;
  livePreviewEnabled: boolean;
  onChange: (body: string) => void;
  onSave: () => void;
  onImageError: (message: string) => void;
  /** App 用它形成“图片任务完成后再保存/切换”的边界。 */
  onImageOperation: (operation: Promise<unknown>) => void;
}

/** CodeMirror 6 编辑器；实时排版仅用 Decoration 改变显示，不改 Markdown 原文。 */
export default function MarkdownEditor({
  sessionKey,
  postId,
  projectGeneration,
  initialBody,
  livePreviewEnabled,
  onChange,
  onSave,
  onImageError,
  onImageOperation,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const initialBodyRef = useRef(initialBody);
  const livePreviewEnabledRef = useRef(livePreviewEnabled);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const postIdRef = useRef(postId);
  const projectGenerationRef = useRef(projectGeneration);
  const onImageErrorRef = useRef(onImageError);
  const onImageOperationRef = useRef(onImageOperation);
  initialBodyRef.current = initialBody;
  livePreviewEnabledRef.current = livePreviewEnabled;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  postIdRef.current = postId;
  projectGenerationRef.current = projectGeneration;
  onImageErrorRef.current = onImageError;
  onImageOperationRef.current = onImageOperation;

  const configuredLivePreview = useMemo(
    () =>
      createLivePreviewExtension({
        loadImage: async (markdownPath) => {
          const bytes = await api.readImageAsset(
            projectGeneration,
            postId,
            markdownPath,
          );
          return new Blob([bytes], { type: imageMimeType(markdownPath) });
        },
      }),
    [postId, projectGeneration],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 部分 WebKitGTK 版本在图片 Ctrl+V 时连可用的 paste 事件都不给。keydown 先安排
    // 一个延迟兜底；正常 paste 一到就取消，因此标准图片和文本都不会重复处理。
    let active = true;
    let keyboardPasteFallback: {
      timer: ReturnType<typeof setTimeout>;
      anchorId: string;
      resolve: () => void;
    } | null = null;
    let viewForFallback: EditorView | null = null;
    const cancelKeyboardPasteFallback = () => {
      const fallback = keyboardPasteFallback;
      if (!fallback) return;
      keyboardPasteFallback = null;
      clearTimeout(fallback.timer);
      if (viewForFallback) {
        cancelImageInsertionAnchor(viewForFallback, fallback.anchorId);
      }
      fallback.resolve();
    };

    const state = EditorState.create({
      doc: initialBodyRef.current,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        imageInsertionAnchorExtension,
        livePreviewCompartmentRef.current.of(
          livePreviewEnabledRef.current ? configuredLivePreview : [],
        ),
        placeholder(i18n.t(($) => $.editor.placeholder)),
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
          keydown(event, view) {
            if (!isPasteShortcut(event)) return false;
            cancelKeyboardPasteFallback();
            const postId = postIdRef.current;
            const projectGeneration = projectGenerationRef.current;
            const range = view.state.selection.main;
            const anchorId = createImageInsertionAnchor(view, {
              from: range.from,
              to: range.to,
            });
            const operation = new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                const fallback = keyboardPasteFallback;
                if (!fallback || fallback.anchorId !== anchorId) {
                  resolve();
                  return;
                }
                keyboardPasteFallback = null;
                void insertClipboardImagesAtAnchor(
                  view,
                  projectGeneration,
                  postId,
                  anchorId,
                  onImageErrorRef.current,
                  true,
                  () => active,
                ).finally(() => {
                  if (active) cancelImageInsertionAnchor(view, anchorId);
                  resolve();
                });
              }, 80);
              keyboardPasteFallback = { timer, anchorId, resolve };
            });
            onImageOperationRef.current(operation);
            // 不拦截默认行为；正常文本粘贴仍由 CodeMirror/WebKit 完成。
            return false;
          },
          paste(event, view) {
            cancelKeyboardPasteFallback();
            const range = view.state.selection.main;
            const images = extractPastedImages(event.clipboardData);

            if (images.length > 0) {
              event.preventDefault();
              onImageOperationRef.current(
                insertImagesSequentially(
                  view,
                  projectGenerationRef.current,
                  postIdRef.current,
                  images,
                  { from: range.from, to: range.to },
                  onImageErrorRef.current,
                  false,
                  () => active,
                ),
              );
              return true;
            }

            // WebKitGTK bug 218519：事件仍会派发，但图片 DataTransfer 可能完全为空。
            // 在 paste 事件里走原生兜底既支持 Ctrl/Cmd+V，也支持右键和应用菜单粘贴。
            if (!needsNativeClipboardFallback(event.clipboardData)) return false;
            const explicitlyImage = hasNativeImageClipboardHint(
              event.clipboardData,
            );
            // 完全空的 DataTransfer 也可能只是 WebKit 隐藏了普通文本：让默认粘贴继续，
            // 同时静默探测原生图片。明确声明 image/* 时才独占这次事件并报告失败。
            if (explicitlyImage) event.preventDefault();
            onImageOperationRef.current(
              insertClipboardImageIfPresent(
                view,
                projectGenerationRef.current,
                postIdRef.current,
                { from: range.from, to: range.to },
                onImageErrorRef.current,
                explicitlyImage,
                () => active,
              ),
            );
            return explicitlyImage;
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
            onImageOperationRef.current(
              insertImagesSequentially(
                view,
                projectGenerationRef.current,
                postIdRef.current,
                images,
                pos,
                onImageErrorRef.current,
                true,
                () => active,
              ),
            );
            return true;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: container });
    viewForFallback = view;
    editorViewRef.current = view;
    return () => {
      active = false;
      cancelKeyboardPasteFallback();
      if (editorViewRef.current === view) editorViewRef.current = null;
      view.destroy();
    };
  }, [sessionKey]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartmentRef.current.reconfigure(
        livePreviewEnabled ? configuredLivePreview : [],
      ),
    });
  }, [configuredLivePreview, livePreviewEnabled]);

  return <div ref={containerRef} className="editor-host" />;
}
