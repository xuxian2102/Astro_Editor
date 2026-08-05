import { useId, useRef } from "react";
import { useModalDialog } from "./useModalDialog";

interface ModalAction {
  label: string;
  kind?: "primary" | "danger";
  onClick: () => void;
}

interface ModalProps {
  title: string;
  message: string;
  actions: ModalAction[];
  /** 省略时 Escape 只会被拦截，不会绕过必须明确选择的操作。 */
  onDismiss?: () => void;
}

/** WebKitGTK 里不用 window.confirm/prompt，统一走应用内模态 */
export default function Modal({
  title,
  message,
  actions,
  onDismiss,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const messageId = `${id}-message`;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  // 可取消的确认框先聚焦“取消”；必须二选一时先聚焦标题，防止 Enter 误操作。
  const initialFocusRef = onDismiss ? firstActionRef : titleRef;
  const { dialogRef, handleDialogKeyDown } =
    useModalDialog<HTMLDivElement>(initialFocusRef);

  return (
    <div className="modal-overlay">
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={(event) => handleDialogKeyDown(event, onDismiss)}
      >
        <h3 ref={titleRef} id={titleId} tabIndex={-1}>
          {title}
        </h3>
        <p id={messageId}>{message}</p>
        <div className="modal-actions">
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              className={action.kind ? `btn-${action.kind}` : undefined}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
