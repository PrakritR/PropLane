/**
 * "Message manager" from a vendor list row (Incoming payments, invoice record): stages who the
 * New message compose should open addressed to, then the row navigates to
 * `/vendor/communication/active?compose=1`, which opens compose once the inbox mounts. One-shot:
 * the draft is consumed (and cleared) by the compose that opens.
 */
import type { ResidentComposePrefill } from "@/lib/resident-compose-prefill";

const STORAGE_KEY = "vendor-compose-prefill-v1";

export const VENDOR_COMPOSE_HREF = "/vendor/communication/active?compose=1";

export function stageVendorComposePrefill(prefill: { managerUserId: string; subject?: string }): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
  } catch {
    /* quota / private mode: compose just opens without a recipient */
  }
}

export function consumeVendorComposePrefill(): ResidentComposePrefill | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as { managerUserId?: unknown; subject?: unknown };
    const managerUserId = typeof parsed.managerUserId === "string" ? parsed.managerUserId.trim() : "";
    if (!managerUserId) return null;
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: "",
      managerUserId,
    };
  } catch {
    return null;
  }
}
