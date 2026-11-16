import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadGuestTourListing } from "@/lib/tour-guest-prospect.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * A guest's finished application, held until a phone or mailbox is proven (captain, Nov 14: a renter from Facebook,
 * Zillow or Roomies applies WITHOUT an account; this overrides the Nov 3 "account first" rule).
 *
 *   stash   the draft is stored under an unguessable token (only its SHA-256 is kept), for 24 hours
 *   proof   the renter proves the phone texted a code, or the mailbox that opened the emailed `token_hash` link
 *   claim   the resident account that proof created takes the draft ONCE; the body is wiped the moment it is taken
 *
 * No account exists before proof, and the draft is never an application row: it reaches the manager only when the
 * resident submits it through the ordinary signed-in write (which runs the per-listing pre-apply gate, the fee gate
 * and every other submit check). The token is a lookup key, never proof: a claim also needs the verified phone or
 * email of the claiming session to be the one the draft names.
 */

export const GUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** A wizard form is a few KB; this is a ceiling against someone using the endpoint as storage. */
export const GUEST_DRAFT_MAX_BYTES = 200 * 1024;

export function hashGuestDraftToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintGuestDraftToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A token is 43 base64url characters; anything else can never match and is not even looked up. */
export function isWellFormedGuestDraftToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type GuestDraftInput = { propertyId: string; form: Row; email: string; phoneE164: string | null };

/** What a stash request must look like. The form is the wizard's own state; the contact fields are read from it. */
export function parseGuestDraftRequest(body: unknown): { ok: true; value: GuestDraftInput } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "A draft is required." };
  const propertyId = text(body.propertyId);
  if (!propertyId || propertyId.length > 200) return { ok: false, error: "Choose a home to apply to." };
  if (!isRecord(body.form)) return { ok: false, error: "A draft is required." };
  let size = 0;
  try {
    size = JSON.stringify(body.form).length;
  } catch {
    return { ok: false, error: "A draft is required." };
  }
  if (size > GUEST_DRAFT_MAX_BYTES) return { ok: false, error: "That application is too large." };
  const email = text(body.form.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { ok: false, error: "Enter a valid email address." };
  const rawPhone = text(body.form.phone);
  const phoneE164 = rawPhone ? normalizeE164(rawPhone) : null;
  if (rawPhone && !phoneE164) return { ok: false, error: "Enter a US phone number." };
  return { ok: true, value: { propertyId, form: body.form, email, phoneE164 } };
}

export type StashResult =
  | { ok: true; token: string; expiresAt: string; draftId: string }
  | { ok: false; status: 404 | 503; error: string };

/**
 * Store the draft. The home is re-derived from the database (a LIVE listing): the request only names an id, and the
 * stored form is stamped with the id the database confirmed.
 */
export async function stashGuestApplicationDraft(db: SupabaseClient, input: GuestDraftInput, now = new Date()): Promise<StashResult> {
  const listing = await loadGuestTourListing(db, input.propertyId);
  if (!listing) return { ok: false, status: 404, error: "This listing is not available." };
  await db.rpc("purge_expired_guest_application_drafts").then(() => undefined, () => undefined);
  const token = mintGuestDraftToken();
  const expiresAt = new Date(now.getTime() + GUEST_DRAFT_TTL_MS).toISOString();
  const { data, error } = await db
    .from("guest_application_drafts")
    .insert({
      token_hash: hashGuestDraftToken(token),
      property_id: listing.propertyId,
      email: input.email,
      phone_e164: input.phoneE164,
      draft: { ...input.form, propertyId: listing.propertyId },
      status: "pending",
      expires_at: expiresAt,
      created_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, status: 503, error: "We could not save your application. Please try again." };
  return { ok: true, token, expiresAt, draftId: String((data as Row).id) };
}

export type ClaimResult =
  | { ok: true; form: Row; propertyId: string }
  | { ok: false; reason: "none" | "unavailable" };

/**
 * The claiming session's PROVEN contact: a confirmed email and/or a verified phone, both read from Auth by the caller.
 * A draft is claimable only when it names one of them, so the token (or the property id) never stands in for proof.
 */
export type VerifiedContact = { email: string | null; phoneE164: string | null };

export async function claimGuestApplicationDraft(
  db: SupabaseClient,
  input: { userId: string; contact: VerifiedContact; propertyId: string; token?: string | null; now?: Date },
): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const email = input.contact.email?.trim().toLowerCase() || null;
  const phone = input.contact.phoneE164 ? normalizeE164(input.contact.phoneE164) : null;
  if (!email && !phone) return { ok: false, reason: "none" };
  const propertyId = input.propertyId.trim();
  if (!propertyId) return { ok: false, reason: "none" };

  let tokenHash: string | null = null;
  if (input.token !== undefined && input.token !== null) {
    if (!isWellFormedGuestDraftToken(input.token)) return { ok: false, reason: "none" };
    tokenHash = hashGuestDraftToken(input.token);
  }
  // The proven contact is part of the QUERY, not a filter over a truncated page: a busy listing can hold
  // more pending drafts than any page size, and the no-token path (a texted sign-in link opened on another
  // device) is the production one. Each proven contact gets its own exact-match read; the newest wins.
  const runContactQuery = async (column: "email" | "phone_e164", value: string) => {
    let query = db
      .from("guest_application_drafts")
      .select("id, email, phone_e164, property_id, draft, created_at")
      .eq("status", "pending")
      .eq("property_id", propertyId)
      .gt("expires_at", now.toISOString())
      .eq(column, value)
      .order("created_at", { ascending: false })
      .limit(1);
    if (tokenHash) query = query.eq("token_hash", tokenHash);
    return query;
  };
  const candidates: Row[] = [];
  for (const [column, value] of [["email", email], ["phone_e164", phone]] as const) {
    if (!value) continue;
    const { data, error } = await runContactQuery(column, value);
    if (error) return { ok: false, reason: "unavailable" };
    candidates.push(...((data ?? []) as Row[]));
  }
  const match = candidates.sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)))[0];
  if (!match || !isRecord(match.draft)) return { ok: false, reason: "none" };

  // One claim wins. The body is wiped in the same statement that takes it.
  const taken = await db
    .from("guest_application_drafts")
    .update({ status: "claimed", claimed_by_user_id: input.userId, claimed_at: now.toISOString(), draft: {} })
    .eq("id", String(match.id))
    .eq("status", "pending")
    .select("id");
  if (taken.error) return { ok: false, reason: "unavailable" };
  if (!taken.data || taken.data.length !== 1) return { ok: false, reason: "none" };
  return { ok: true, form: match.draft, propertyId };
}
