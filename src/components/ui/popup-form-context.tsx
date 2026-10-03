"use client";

import { useEffect, useState, type RefObject } from "react";

type Field = { label: string; value: string; invalid: boolean; element: HTMLElement };

/** Read only the visible form controls. No credentials, hidden fields or inferred output. */
export function readPopupFields(root: HTMLElement): Field[] {
  return Array.from(root.querySelectorAll<HTMLElement>('input,textarea,select,[role="combobox"]')).flatMap((element) => {
    if (element.closest('[hidden],[aria-hidden="true"]') || element.matches(':disabled,input[type="hidden"],input[type="password"],input[type="file"]')) return [];
    const control = element as HTMLInputElement;
    const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    const labelNode = control.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
    labelNode?.querySelectorAll("input,textarea,select,button").forEach(child => child.remove());
    const label = (labelledBy || element.getAttribute("aria-label") || labelNode?.textContent || "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
    if (!label || /password|secret|access token/i.test(label) || /password/.test(element.getAttribute("autocomplete") ?? "")) return [];
    const value = element instanceof HTMLSelectElement ? Array.from(element.selectedOptions).map(option => option.text).join(", ")
      : element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? (element.checked ? "Yes" : "No")
      : element.getAttribute("role") === "combobox" ? element.textContent?.trim() ?? ""
      : control.value ?? "";
    const invalid = Boolean(control.willValidate && !control.validity.valid) || element.getAttribute("aria-invalid") === "true";
    return [{ label, value, invalid, element }];
  });
}

/** Shared rail stays in sync with real inputs; explicit record context takes precedence. */
function usePopupFields(formRef: RefObject<HTMLDivElement | null>) {
  const [fields, setFields] = useState<Field[]>([]);
  useEffect(() => {
    const root = formRef.current;
    if (!root) return;
    const update = () => {
      const next = readPopupFields(root);
      setFields(previous => previous.length === next.length && previous.every((field, index) => {
        const other = next[index];
        return field.element === other.element && field.label === other.label && field.value === other.value && field.invalid === other.invalid;
      }) ? previous : next);
    };
    update();
    root.addEventListener("input", update);
    root.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => { observer.disconnect(); root.removeEventListener("input", update); root.removeEventListener("change", update); };
  }, [formRef]);
  return fields;
}

export function PopupFormContext({ formRef, hasContext }: { formRef: RefObject<HTMLDivElement | null>; hasContext: boolean }) {
  const fields = usePopupFields(formRef);
  const missing = fields.filter(field => field.invalid);
  const context = fields.filter(field => field.value.trim()).slice(0, 4);
  return <div className="space-y-4">
    {!hasContext && context.length > 0 ? <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm" data-attr="popup-form-context">
      {context.map((field, index) => <div key={`${field.label}-${index}`} className="py-3"><dt className="text-xs text-muted">{field.label}</dt><dd className="mt-1 break-words font-semibold">{field.value}</dd></div>)}
    </dl> : null}
    {missing.length > 0 ? <div className="rounded-xl border border-danger/25 bg-danger/5 p-3 text-sm text-danger" data-attr="popup-things-to-finish">
      <div className="font-semibold">{missing.length} {missing.length === 1 ? "thing" : "things"} to finish</div>
      {missing.map((field, index) => <button key={`${field.label}-${index}`} type="button" className="block min-h-11 w-full text-left" onClick={() => { field.element.scrollIntoView?.({ block: "center" }); field.element.focus(); }}>{field.label}</button>)}
    </div> : null}
  </div>;
}

/** Settings and other value-only forms get an exact read-only snapshot of their draft.
 * Domain outputs (email, charge, invoice, receipt) supply a caller-owned preview instead.
 */
export function PopupFormSnapshot({ formRef }: { formRef: RefObject<HTMLDivElement | null> }) {
  const fields = usePopupFields(formRef);
  return <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4 text-sm" data-attr="popup-draft-preview">
    {fields.map((field, index) => <div key={`${field.label}-${index}`} className="py-3"><dt className="text-xs text-muted">{field.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words font-semibold">{field.value || "Not set"}</dd></div>)}
    {fields.length === 0 ? <div className="py-3 text-muted">No changes</div> : null}
  </dl>;
}
