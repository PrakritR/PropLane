/**
 * Vendor quick replies: saved messages a vendor inserts into a conversation
 * (and, later, a bid note or a review reply). Each vendor's own, seeded with a
 * starter set until they save a list of their own.
 *
 * Stored server-side under `notification_preferences.row_data.vendorQuickReplies`
 * (the per-user JSON row the vendor notification settings already use) — see
 * `vendor-quick-replies.server.ts`. Pure helpers only here, so the settings
 * pane, the picker and the route all read one normalizer.
 */

export const VENDOR_QUICK_REPLY_MAX_COUNT = 20;
export const VENDOR_QUICK_REPLY_MAX_LENGTH = 500;

export type VendorQuickReply = { id: string; text: string };

/** The starter set a vendor sees until they save their own (approved plan, Oct 6). */
export const VENDOR_QUICK_REPLY_STARTERS: readonly string[] = [
  "On my way",
  "Running 15 minutes late",
  "Need photos of the issue",
  "Can I come by for an estimate?",
  "Job complete — invoice sent",
];

export function starterVendorQuickReplies(): VendorQuickReply[] {
  return VENDOR_QUICK_REPLY_STARTERS.map((text, index) => ({ id: `starter-${index + 1}`, text }));
}

function newId(): string {
  const random =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `qr-${random}`;
}

/**
 * Coerce anything (a stored blob, a request body) into a clean list: trimmed,
 * non-empty, capped in length and count, with unique ids. Returns `null` when
 * the input is not an array at all, so callers can tell "never saved" (use the
 * starters) from "saved an empty list".
 */
export function normalizeVendorQuickReplies(raw: unknown): VendorQuickReply[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: VendorQuickReply[] = [];
  for (const item of raw) {
    const candidate =
      typeof item === "string"
        ? { id: "", text: item }
        : item && typeof item === "object"
          ? (item as { id?: unknown; text?: unknown })
          : null;
    if (!candidate || typeof candidate.text !== "string") continue;
    const text = candidate.text.trim().slice(0, VENDOR_QUICK_REPLY_MAX_LENGTH);
    if (!text) continue;
    let id = typeof candidate.id === "string" ? candidate.id.trim().slice(0, 64) : "";
    if (!id || seen.has(id)) id = newId();
    seen.add(id);
    out.push({ id, text });
    if (out.length >= VENDOR_QUICK_REPLY_MAX_COUNT) break;
  }
  return out;
}

export function addVendorQuickReply(list: VendorQuickReply[], text: string): VendorQuickReply[] {
  return normalizeVendorQuickReplies([...list, { id: newId(), text }]) ?? list;
}

export function editVendorQuickReply(list: VendorQuickReply[], id: string, text: string): VendorQuickReply[] {
  return normalizeVendorQuickReplies(list.map((item) => (item.id === id ? { id, text } : item))) ?? list;
}

export function deleteVendorQuickReply(list: VendorQuickReply[], id: string): VendorQuickReply[] {
  return list.filter((item) => item.id !== id);
}

/** Move one reply up (`-1`) or down (`1`); a move off either end is a no-op. */
export function moveVendorQuickReply(list: VendorQuickReply[], id: string, direction: -1 | 1): VendorQuickReply[] {
  const from = list.findIndex((item) => item.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Insert a quick reply into a draft: an empty draft becomes the reply, a
 * non-empty one gets the reply on a new line (never overwriting what the vendor
 * already typed). The result stays editable.
 */
export function insertQuickReplyText(draft: string, reply: string, maxLength?: number): string {
  const base = draft.trim() ? `${draft.replace(/\s+$/, "")}\n${reply}` : reply;
  return typeof maxLength === "number" ? base.slice(0, maxLength) : base;
}
