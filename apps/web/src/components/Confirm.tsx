import { useState } from "react";

/**
 * Confirm-before-delete hook for destructive actions (delete test/step).
 * Returns a `confirm()` promise + dialog element to render.
 */
export function useConfirm() {
  const [pending, setPending] = useState<{
    message: string;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => setPending({ message, resolve }));

  const close = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
  };

  const dialog = pending ? (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-label="Confirm">
        <p>{pending.message}</p>
        <div className="row">
          <button type="button" className="btn" autoFocus onClick={() => close(false)}>
            Keep
          </button>
          <button type="button" className="btn btn-danger" onClick={() => close(true)}>
            Delete
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
