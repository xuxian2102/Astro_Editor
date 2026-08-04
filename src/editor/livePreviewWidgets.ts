import { EditorView, WidgetType } from "@codemirror/view";

export type LivePreviewImageState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "error"; message: string };

export interface MarkdownImageDescriptor {
  target: string;
  alt: string;
  title: string | null;
}

export class CodeLanguageWidget extends WidgetType {
  constructor(readonly language: string) {
    super();
  }

  eq(other: CodeLanguageWidget) {
    return other.language === this.language;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-live-code-language";
    element.textContent = this.language || "代码";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

export class HorizontalRuleWidget extends WidgetType {
  eq(_other: HorizontalRuleWidget) {
    return true;
  }

  toDOM() {
    const separator = document.createElement("span");
    separator.className = "cm-live-horizontal-rule";
    separator.setAttribute("role", "separator");
    separator.setAttribute("aria-label", "分隔线");
    return separator;
  }
}

export class ListMarkerWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly ordered: boolean,
  ) {
    super();
  }

  eq(other: ListMarkerWidget) {
    return other.label === this.label && other.ordered === this.ordered;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = this.ordered
      ? "cm-live-list-marker cm-live-list-marker-ordered"
      : "cm-live-list-marker cm-live-list-marker-bullet";
    marker.textContent = this.label;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

export function taskToggleChange(markerFrom: number, checked: boolean) {
  return {
    from: markerFrom + 1,
    to: markerFrom + 2,
    insert: checked ? "x" : " ",
  };
}

export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly markerFrom: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return (
      other.markerFrom === this.markerFrom && other.checked === this.checked
    );
  }

  toDOM(view: EditorView) {
    const checkbox = document.createElement("input");
    checkbox.className = "cm-live-task-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.setAttribute(
      "aria-label",
      this.checked ? "标记任务为未完成" : "标记任务为已完成",
    );
    checkbox.addEventListener("change", () => {
      view.dispatch({
        changes: taskToggleChange(this.markerFrom, checkbox.checked),
      });
    });
    return checkbox;
  }

  ignoreEvent() {
    return true;
  }
}

export class MarkdownImageWidget extends WidgetType {
  constructor(
    readonly image: MarkdownImageDescriptor,
    readonly state: LivePreviewImageState,
  ) {
    super();
  }

  eq(other: MarkdownImageWidget) {
    return (
      other.image.target === this.image.target &&
      other.image.alt === this.image.alt &&
      other.image.title === this.image.title &&
      other.state.status === this.state.status &&
      (other.state.status !== "ready" ||
        (this.state.status === "ready" && other.state.src === this.state.src)) &&
      (other.state.status !== "error" ||
        (this.state.status === "error" &&
          other.state.message === this.state.message))
    );
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-live-image cm-live-image-${this.state.status}`;

    if (this.state.status === "ready") {
      const image = document.createElement("img");
      image.src = this.state.src;
      image.alt = this.image.alt;
      if (this.image.title) image.title = this.image.title;
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      image.referrerPolicy = "no-referrer";
      image.addEventListener("load", () => view.requestMeasure(), {
        once: true,
      });
      image.addEventListener(
        "error",
        () => {
          wrapper.className = "cm-live-image cm-live-image-error";
          wrapper.textContent = `图片无法加载：${this.image.alt || this.image.target}`;
          view.requestMeasure();
        },
        { once: true },
      );
      wrapper.append(image);
    } else {
      wrapper.textContent =
        this.state.status === "loading"
          ? `图片加载中：${this.image.alt || this.image.target}`
          : `图片预览失败：${this.state.message}`;
      if (this.state.status === "error") wrapper.title = this.image.target;
    }
    return wrapper;
  }
}
