"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function ResidentLifecycleDialog({
  title,
  body,
  onClose,
  backLabel,
  fields,
}: {
  title: string;
  body: string;
  onClose(): void;
  backLabel: string;
  fields?: { label: string; value: string }[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="rlp-modal"
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="rlp-modal-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="rlp-icon-button"
          onClick={onClose}
          aria-label="Close"
        >
          <X aria-hidden />
        </button>
      </div>
      {fields ? null : <p>{body}</p>}
      {fields ? (
        <div className="rlp-modal-fields">
          {fields.map((field) => (
            <label key={field.label}>
              {field.label}
              <input defaultValue={field.value} />
            </label>
          ))}
        </div>
      ) : null}
      <div className="rlp-modal-facts">
        <span>Seattle Homes</span>
      </div>
      <button type="button" className="rlp-modal-close" onClick={onClose}>
        {backLabel}
      </button>
    </dialog>
  );
}
