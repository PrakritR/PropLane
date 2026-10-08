/**
 * Vendor AI info: the facts the AI on a vendor's PropLane number may state.
 * Service area and trades are not stored here - they are read from the
 * business profile. Client-safe (no server imports).
 */
export const VENDOR_AI_INFO_KEYS = ["hours", "rates", "how_to_book", "emergency", "extra"] as const;
export type VendorAiInfoKey = (typeof VENDOR_AI_INFO_KEYS)[number];
export type VendorAiInfo = Record<VendorAiInfoKey, string>;

export const VENDOR_AI_INFO_MAX_LENGTH = 1000;

export const VENDOR_AI_INFO_LABELS: Record<VendorAiInfoKey, string> = {
  hours: "Hours",
  rates: "Rates",
  how_to_book: "How to book",
  emergency: "Emergencies",
  extra: "Anything else",
};

export const EMPTY_VENDOR_AI_INFO: VendorAiInfo = { hours: "", rates: "", how_to_book: "", emergency: "", extra: "" };

/** Read a stored value defensively: unknown keys and non-strings are dropped. */
export function readVendorAiInfo(raw: unknown): VendorAiInfo {
  const out: VendorAiInfo = { ...EMPTY_VENDOR_AI_INFO };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of VENDOR_AI_INFO_KEYS) {
    const value = record[key];
    if (typeof value === "string") out[key] = value.trim().slice(0, VENDOR_AI_INFO_MAX_LENGTH);
  }
  return out;
}

export function vendorAiInfoIsEmpty(info: VendorAiInfo): boolean {
  return VENDOR_AI_INFO_KEYS.every((key) => info[key].trim() === "");
}

export type VendorAiInfoPatchResult = { ok: true; patch: Partial<VendorAiInfo> } | { ok: false; error: string };

/**
 * Validate a client patch. Only the known keys are read; each must be a string
 * within the cap. Anything else in the body is ignored, never stored.
 */
export function parseVendorAiInfoPatch(raw: unknown): VendorAiInfoPatchResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "AI info must be an object." };
  const record = raw as Record<string, unknown>;
  const patch: Partial<VendorAiInfo> = {};
  for (const key of VENDOR_AI_INFO_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value !== "string") return { ok: false, error: `${VENDOR_AI_INFO_LABELS[key]} must be text.` };
    const trimmed = value.trim();
    if (trimmed.length > VENDOR_AI_INFO_MAX_LENGTH) {
      return { ok: false, error: `${VENDOR_AI_INFO_LABELS[key]} must be ${VENDOR_AI_INFO_MAX_LENGTH} characters or fewer.` };
    }
    patch[key] = trimmed;
  }
  return { ok: true, patch };
}
