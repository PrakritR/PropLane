"use client";

import { createContext, useContext } from "react";

export const WizardInvalidFields = createContext<ReadonlySet<string>>(new Set());
export function WizardFieldError({ id }: { id: string }) {
  const invalid = useContext(WizardInvalidFields).has(id);
  return invalid ? <span role="alert" className="mt-1 block text-xs font-semibold text-destructive">Required</span> : null;
}

export type MissingWizardField = { id: string; label: string; element: HTMLElement };
export function isVisibleWizardField(field: HTMLElement, root: HTMLElement): boolean {
  if (field.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let node: HTMLElement | null = field; node && node !== root; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/** Read only declared requirements; a optional picker is never inferred to be mandatory. */
export function missingWizardFields(root: HTMLElement | null): MissingWizardField[] {
  if (!root) return [];
  const missing = new Map<string, MissingWizardField>();
  for (const wrapper of root.querySelectorAll<HTMLElement>('[data-wizard-required="true"]')) {
    if (!isVisibleWizardField(wrapper, root)) continue;
    const id = wrapper.dataset.wizardField ?? wrapper.id;
    const label = wrapper.dataset.wizardLabel || "This field";
    const control = wrapper.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, button:not([disabled])');
    let empty = wrapper.dataset.wizardEmpty === "true";
    if (wrapper.dataset.wizardEmpty == null) {
      const input = wrapper.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
      if (input) empty = !input.value.trim();
      else empty = !wrapper.querySelector('[aria-pressed="true"], [aria-checked="true"], [data-selected="true"]');
    }
    if (empty && control) missing.set(id, { id, label, element: control });
  }
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("main input, main select, main textarea")) {
    if (!isVisibleWizardField(field, root) || !field.willValidate || field.validity.valid) continue;
    const wrapper = field.closest<HTMLElement>('[data-wizard-field]');
    const id = wrapper?.dataset.wizardField ?? field.id ?? field.name;
    const label = wrapper?.dataset.wizardLabel || field.labels?.[0]?.textContent?.replace(/\\s*\\(required\\)/g, "").trim() || field.getAttribute("aria-label") || "Required fields";
    missing.set(id || label, { id: id || label, label, element: field });
  }
  return [...missing.values()];
}

/** One line for the footer: the first thing missing, and how many more. "Full name (+4 more)". */
export function summarizeMissingFields(fields: readonly Pick<MissingWizardField, "label">[]): string {
  if (!fields.length) return "";
  const [first, ...rest] = fields;
  return rest.length ? `${first!.label} (+${rest.length} more)` : first!.label;
}
