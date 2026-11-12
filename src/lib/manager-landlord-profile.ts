/**
 * The landlord's legal name on generated leases. Order (captain, 2026-11-10):
 *   1. the workspace setting "Landlord on leases" (Settings -> Workspace -> Leases), stored under the
 *      workspace OWNER on the workspace rung and resolved by
 *      `manager-landlord-profile.server.ts` (its account row,
 *      `manager_automation_settings.row_data.landlordProfile`, is the fallback for a workspace that
 *      has none of its own);
 *   2. the workspace OWNER's `profiles.full_name`. On a PropLane-managed workspace the owner is
 *      the client, never the staff member who is signed in;
 *   3. the placeholder, which `leaseLandlordNameBlocker` refuses to send.
 *
 * Every generated lease has a Parties section and a signature block. The template falls
 * back to `[LANDLORD ENTITY NAME]` when no name is available, and `leaseLandlordNameBlocker`
 * refuses to send that document.
 */
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { selectedWorkspaceId } from "@/lib/workspaces/selection";
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

/** Normalize the manager account's full name for lease party printing. */
export function landlordLegalNameFromAccountFullName(fullName: string | null | undefined): string {
  const validated = validateLandlordLegalName(fullName);
  return validated.ok ? validated.landlordLegalName : "";
}

export async function loadManagerLandlordLegalNameFromProfile(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string> {
  const { data, error } = await db
    .from("profiles")
    .select("full_name")
    .eq("id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return landlordLegalNameFromAccountFullName(data?.full_name);
}

export type LandlordNameSource = "setting" | "owner" | "none";

/**
 * The one decision: the workspace setting wins, then the workspace owner's account name, else
 * nothing. Both inputs are the OWNER's, so a signed-in staff member's own name never reaches it.
 */
export function pickLandlordLegalName(input: {
  setting?: string | null;
  ownerFullName?: string | null;
}): { landlordLegalName: string; source: LandlordNameSource } {
  const setting = normalizeManagerLandlordProfile({ landlordLegalName: input.setting }).landlordLegalName;
  if (setting) return { landlordLegalName: setting, source: "setting" };
  const owner = landlordLegalNameFromAccountFullName(input.ownerFullName);
  if (owner) return { landlordLegalName: owner, source: "owner" };
  return { landlordLegalName: "", source: "none" };
}

/**
 * The landlord name from the ACCOUNT rung, read as its owner: account setting, then owner's full name.
 * A workspace-aware caller uses `resolveLandlordLegalNameForScope` instead, which puts that workspace's
 * own setting ahead of this.
 */
export async function resolveWorkspaceLandlordLegalName(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<{ landlordLegalName: string; source: LandlordNameSource; setting: string; ownerFullName: string }> {
  const [profile, ownerFullName] = await Promise.all([
    loadManagerLandlordProfile(db, ownerUserId),
    loadManagerLandlordLegalNameFromProfile(db, ownerUserId),
  ]);
  const picked = pickLandlordLegalName({ setting: profile.landlordLegalName, ownerFullName });
  return { ...picked, setting: profile.landlordLegalName, ownerFullName };
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

/**
 * Sandbox managers get an initial landlord legal name from signup `fullName` so
 * lease generation works without a manual Settings pass. Production managers still
 * set this explicitly; an existing saved name is never overwritten.
 */
export async function ensureSandboxManagerLandlordProfile(
  db: SupabaseClient,
  opts: { managerUserId: string; email: string; fullName?: string | null },
): Promise<void> {
  if (!isPortalSandboxEmail(opts.email)) return;
  const validated = validateLandlordLegalName(opts.fullName);
  if (!validated.ok || !validated.landlordLegalName) return;

  const existing = await loadManagerLandlordProfile(db, opts.managerUserId);
  if (existing.landlordLegalName) return;

  await saveManagerLandlordProfile(db, opts.managerUserId, {
    landlordLegalName: validated.landlordLegalName,
  });
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
 *
 * The name belongs to ONE workspace, so an entry exists only for a NAMED workspace and a read from
 * any other (or before the workspace selection has loaded) is a MISS. Without that, switching
 * workspace printed the previous workspace's landlord party until the refetch landed, and a read
 * taken before the selection loaded printed the ACCOUNT rung's name — both the wrong-but-present
 * case `leaseLandlordNameBlocker` cannot catch.
 */
const LANDLORD_NAME_CACHE_KEY = "axis:landlord-legal-name";
let memoryLandlordLegalName: { scope: string; name: string } | null = null;

/** The workspace a cache entry belongs to, or null when no workspace is selected yet — never a scope of its own. */
function landlordCacheScope(workspaceId?: string | null): string | null {
  const id = (workspaceId === undefined ? selectedWorkspaceId() : workspaceId)?.trim() ?? "";
  return id || null;
}

/**
 * Remember the name the server resolved for a workspace. `workspaceId` is the workspace it was read
 * for; omit it only when that is the active one. With no workspace to attach it to, nothing is
 * cached (and any previous entry is dropped): an unattributable name must never reach a lease.
 */
export function cacheLandlordLegalName(name: string, workspaceId?: string | null): void {
  const clean = normalizeManagerLandlordProfile({ landlordLegalName: name }).landlordLegalName;
  const scope = landlordCacheScope(workspaceId);
  const storable = scope && clean ? { scope, name: clean } : null;
  memoryLandlordLegalName = storable;
  if (typeof window === "undefined") return;
  try {
    if (storable) {
      window.localStorage.setItem(LANDLORD_NAME_CACHE_KEY, JSON.stringify({ workspaceId: storable.scope, name: storable.name }));
    } else {
      window.localStorage.removeItem(LANDLORD_NAME_CACHE_KEY);
    }
  } catch {
    /* a full or blocked localStorage just means the generator falls back */
  }
}

/**
 * The cached name for the ACTIVE workspace, or "" when the cache holds another workspace's, holds
 * nothing, or no workspace is selected yet.
 */
export function cachedLandlordLegalName(): string {
  const scope = landlordCacheScope();
  if (!scope) return "";
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(LANDLORD_NAME_CACHE_KEY)?.trim() ?? "";
      if (raw) {
        // A pre-scope entry was a bare name with no workspace on it: unusable, so it reads as a miss.
        const parsed = raw.startsWith("{") ? (JSON.parse(raw) as { workspaceId?: unknown; name?: unknown }) : null;
        const storedScope = typeof parsed?.workspaceId === "string" ? parsed.workspaceId.trim() : "";
        const storedName = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        return storedScope && storedScope === scope && storedName ? storedName : "";
      }
    } catch {
      /* fall through */
    }
  }
  return memoryLandlordLegalName?.scope === scope ? memoryLandlordLegalName.name : "";
}

/**
 * Load the workspace's landlord name from the server and refresh the generator cache. Read as the
 * workspace OWNER (setting, then the owner's full name), never the signed-in user's own name. The
 * entry is scoped to the workspace it was read for, so a switch mid-flight never leaves the other
 * workspace's name where the generator can print it.
 *
 * Nothing is read until there IS a workspace: an unqualified read resolves the ACCOUNT rung, which
 * is not this workspace's answer and must never be cached as one.
 */
export async function fetchAndCacheLandlordLegalName(workspaceId?: string | null): Promise<string> {
  if (typeof window === "undefined") return "";
  if (!workspaceId?.trim()) return "";
  try {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`/api/portal/manager-application-settings${query}`, { credentials: "include", cache: "no-store" });
    if (!res.ok) return cachedLandlordLegalName();
    const data = (await res.json().catch(() => ({}))) as { landlord?: { landlordLegalName?: string | null } };
    const saved = normalizeManagerLandlordProfile({ landlordLegalName: data.landlord?.landlordLegalName }).landlordLegalName;
    cacheLandlordLegalName(saved, workspaceId ?? null);
    return saved;
  } catch {
    return cachedLandlordLegalName();
  }
}
