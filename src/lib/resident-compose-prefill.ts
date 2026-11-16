/** Staged compose draft when navigating from another resident portal section. */

export type ResidentComposePrefill = {
  subject: string;
  body: string;
  /** Manager compose picker — email wins when both are set. */
  recipientEmail?: string;
  /** The manager's name, matched when their address here is a work email the picker does not list. */
  recipientName?: string;
  managerUserId?: string;
  propertyId?: string;
  propertyTitle?: string;
};

const STORAGE_KEY = "resident-compose-prefill-v1";

export function stageResidentComposePrefill(prefill: ResidentComposePrefill): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
  } catch {
    /* quota / private mode */
  }
}

export function consumeResidentComposePrefill(): ResidentComposePrefill | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as ResidentComposePrefill;
    if (!parsed?.subject?.trim() || !parsed?.body?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}
