interface ModalAction {
  label: string;
  kind?: "primary" | "danger";
  onClick: () => void;
}

interface ModalProps {
  title: string;
  message: string;
  actions: ModalAction[];
}

/** WebKitGTK 里不用 window.confirm/prompt，统一走应用内模态 */
export default function Modal({ title, message, actions }: ModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true">
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          {actions.map((action) => (
            <button
              key={action.label}
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
