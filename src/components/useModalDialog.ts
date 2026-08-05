import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// 正常情况下只会有一个对话框；窗口关闭请求可能叠加确认框，因此仍按栈处理，
// 避免两个 focusin 监听器互相抢焦点。
const activeDialogs: HTMLElement[] = [];

function topDialog(): HTMLElement | undefined {
  return activeDialogs.at(-1);
}

function syncDialogLayers() {
  for (const [index, dialog] of activeDialogs.entries()) {
    dialog
      .closest<HTMLElement>(".modal-overlay")
      ?.style.setProperty("--modal-stack-index", String(index));
  }
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

/** 为自定义模态框提供初始焦点、焦点圈定、Escape 关闭和关闭后焦点恢复。 */
export function useModalDialog<T extends HTMLElement>(
  initialFocusRef: RefObject<HTMLElement | null>,
) {
  const dialogRef = useRef<T>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    activeDialogs.push(dialog);
    syncDialogLayers();

    const focusInitialElement = () => {
      const target =
        initialFocusRef.current ?? focusableElements(dialog)[0] ?? dialog;
      target.focus();
    };
    focusInitialElement();

    const keepFocusInside = (event: FocusEvent) => {
      if (
        topDialog() !== dialog ||
        !(event.target instanceof Node) ||
        dialog.contains(event.target)
      ) {
        return;
      }
      focusInitialElement();
    };
    document.addEventListener("focusin", keepFocusInside, true);

    return () => {
      document.removeEventListener("focusin", keepFocusInside, true);
      const wasTopDialog = topDialog() === dialog;
      const index = activeDialogs.lastIndexOf(dialog);
      if (index >= 0) activeDialogs.splice(index, 1);
      syncDialogLayers();
      if (wasTopDialog && previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [initialFocusRef]);

  const handleDialogKeyDown = (
    event: ReactKeyboardEvent<T>,
    onDismiss?: () => void,
  ) => {
    const dialog = dialogRef.current;
    if (!dialog || topDialog() !== dialog) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss?.();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const activeIndex = focusable.indexOf(
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : dialog,
    );
    const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
    const shouldWrapForward =
      !event.shiftKey &&
      (activeIndex === -1 || activeIndex === focusable.length - 1);
    if (!shouldWrapBackward && !shouldWrapForward) return;

    event.preventDefault();
    const target = shouldWrapBackward ? focusable.at(-1) : focusable[0];
    target?.focus();
  };

  return { dialogRef, handleDialogKeyDown };
}
