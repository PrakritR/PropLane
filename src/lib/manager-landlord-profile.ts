/**
 * The landlord's legal name — the party a lease actually names.
 *
 * Every generated lease has a Parties section and a signature block, and until this existed
 * PropLane had nothing to put in them. The template fell back to the listing's BUILDING name —
 * which is a place, not a legal person — and then to the literal string `[LANDLORD ENTITY NAME]`,
 * which shipped verbatim onto documents residents were asked to sign.
 *
 * This is the landlord as they should appear on a contract: a person ("Jane Doe") or an entity
 * ("Doe Property Holdings LLC"). It is deliberately NOT derived from anything — not the building,
 * not the account's display name, not the sign-in email. A lease names its parties exactly, and a
 * guessed party is worse than an obviously missing one, so a blank here stays blank and
 * `leaseLandlordNameBlocker` stops the send instead.
 *
 * Stored on `manager_automation_settings.row_data.landlordProfile`, beside `applicationSettings`
 * and `applicationAutomation`, for the same reason: that table always has a `row_data` JSON
 * column, so this needs no migration and cannot break on a production project whose columns lag
 * dev. Writes merge into the existing blob rather than replacing it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** What the lease template prints when it has no landlord name to use. */
export const LEASE_LANDLORD_PLACEHOLDER = "[LANDLORD ENTITY NAME]";

export type ManagerLandlordProfile = {
  /** Legal name of the landlord party, or "" when the manager has not set one. */
  landlordLegalName: string;
};

export const DEFAULT_MANAGER_LANDLORD_PROFILE: ManagerLandlordProfile = {
  landlordLegalName: "",
};

/** Long enough for a real entity name, short enough that nothing pathological reaches a lease. */
export const MAX_LANDLORD_LEGAL_NAME_LENGTH = 160;

const ROW_DATA_KEY = "landlordProfile";

export function normalizeManagerLandlordProfile(raw: unknown): ManagerLandlordProfile {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const name = typeof row.landlordLegalName === "string" ? row.landlordLegalName : "";
  // Collapse internal runs of whitespace as well as trimming the ends: a name is rendered into
  // the Parties block, where "Doe   Holdings  LLC" reads as a typo on a contract.
  return { landlordLegalName: name.replace(/\s+/g, " ").trim().slice(0, MAX_LANDLORD_LEGAL_NAME_LENGTH) };
}

export type LandlordLegalNameValidation =
  | { ok: true; landlordLegalName: string }
  | { ok: false; error: string };

/**
 * Write-path validation. Unlike the tolerant normalizer, this REJECTS input the manager should
 * fix rather than silently storing something odd on a legal document. Clearing the name back to
 * "" is allowed — a manager may be mid-setup — and the send gate is what keeps an unnamed
 * landlord off a signature request.
 */
export function validateLandlordLegalName(raw: unknown): LandlordLegalNameValidation {
  if (raw == null) return { ok: true, landlordLegalName: "" };
  if (typeof raw !== "string") return { ok: false, error: "Enter the landlord's legal name." };
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: true, landlordLegalName: "" };
  if (name.length > MAX_LANDLORD_LEGAL_NAME_LENGTH) {
    return { ok: false, error: `The landlord name cannot exceed ${MAX_LANDLORD_LEGAL_NAME_LENGTH} characters.` };
  }
  // A single character is never a real party and is the shape a stray keystroke leaves behind.
  if (name.length < 2) {
    return { ok: false, error: "Enter the landlord's full legal name." };
  }
  // Angle brackets would be escaped downstream anyway; refusing them here keeps the stored value
  // recognisable as a name rather than something that merely renders safely.
  if (/[<>]/.test(name)) {
    return { ok: false, error: "The landlord name cannot contain < or >." };
  }
  return { ok: true, landlordLegalName: name };
}

export async function loadManagerLandlordProfile(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerLandlordProfile> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeManagerLandlordProfile((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

export async function saveManagerLandlordProfile(
  db: SupabaseClient,
  managerUserId: string,
  profile: unknown,
): Promise<ManagerLandlordProfile> {
  const normalized = normalizeManagerLandlordProfile(profile);
  // Read-modify-write: replacing `row_data` outright would take the manager's application fee and
  // automation flags with it.
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = normalized;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}

/* -------------------------------------------------------------------------- */
/* Browser-side cache                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lease generation is synchronous and runs in the browser (`generateLeaseHtmlForRow`), so it
 * cannot await the server for the landlord name. The settings surface writes the saved value
 * here and the generator reads it.
 *
 * This is a CACHE of the server value, never the source of truth: a miss produces a lease that
 * still carries the placeholder, and `leaseLandlordNameBlocker` refuses to send that — so a stale
 * or empty cache costs a regenerate, never a wrong party on a signed document.
 */
const LANDLORD_NAME_CACHE_KEY = "axis:landlord-legal-name";
let memoryLandlordLegalName = "";

export function cacheLandlordLegalName(name: string): void {
  const clean = normalizeManagerLandlordProfile({ landlordLegalName: name }).landlordLegalName;
  memoryLandlordLegalName = clean;
  if (typeof window === "undefined") return;
  try {
    if (clean) window.localStorage.setItem(LANDLORD_NAME_CACHE_KEY, clean);
    else window.localStorage.removeItem(LANDLORD_NAME_CACHE_KEY);
  } catch {
    /* a full or blocked localStorage just means the generator falls back */
  }
}

export function cachedLandlordLegalName(): string {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(LANDLORD_NAME_CACHE_KEY)?.trim() ?? "";
      if (stored) return stored;
    } catch {
      /* fall through */
    }
  }
  return memoryLandlordLegalName;
}

/** Load the saved landlord legal name from the server and refresh the generator cache. */
export async function fetchAndCacheLandlordLegalName(): Promise<string> {
  if (typeof window === "undefined") return "";
  try {
    const res = await fetch("/api/portal/manager-application-settings", { credentials: "include" });
    if (!res.ok) return cachedLandlordLegalName();
    const data = (await res.json().catch(() => ({}))) as {
      landlord?: { landlordLegalName?: string } | null;
    };
    const saved = (data.landlord?.landlordLegalName ?? "").trim();
    cacheLandlordLegalName(saved);
    return saved;
  } catch {
    return cachedLandlordLegalName();
  }
}
