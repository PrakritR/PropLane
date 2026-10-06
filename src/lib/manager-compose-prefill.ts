/** Staged compose draft when navigating from another portal section (e.g. new vendor onboarding). */

export type ManagerComposePrefill = {
  subject: string;
  body: string;
  recipientEmail?: string;
  /** Open to this roster vendor (manager_vendor_records id), by text. */
  vendorRecordId?: string;
};

const STORAGE_KEY = "manager-compose-prefill-v1";

export function stageManagerComposePrefill(prefill: ManagerComposePrefill): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
  } catch {
    /* quota / private mode */
  }
}

export function consumeManagerComposePrefill(): ManagerComposePrefill | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as ManagerComposePrefill;
    // A vendor "Text" stages a recipient only; every other prefill carries a drafted message.
    if (parsed?.vendorRecordId?.trim()) return { subject: "", body: "", vendorRecordId: parsed.vendorRecordId.trim() };
    if (!parsed?.subject?.trim() || !parsed?.body?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}
