/**
 * Context for the resident's personal PropLane agent: the AI behind the number a subscribed resident
 * owns (docs/ai-assistant.md § Resident personal agent). Built by the inbound SMS handler from the
 * number that was TEXTED: the resident is whoever owns it, resolved from our table, never from the
 * message, a tool input or a phone typed by anyone. Its own type, so no manager, leasing, resident
 * portal or vendor tool can typecheck into the registry that binds to it.
 *
 * Unlike the resident portal context it holds NO managers: this agent searches the public catalog
 * across every manager and contacts one only on a listing the resident chose, so there is no
 * "active manager" and no private manager data to scope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { normalizeE164 } from "@/lib/phone-e164";

export type ResidentPersonalAgentContext = {
  kind: "resident_personal_agent";
  /** The number owner's user id: the only scope key every tool applies. */
  userId: string;
  /** audit_log / agent_sessions scope column value (the resident's own user id). */
  landlordId: string;
  /** The resident's account email. Server-resolved; the only email a tool may act as. */
  email: string;
  fullName: string;
  /** The resident's verified phone (E.164) - the only phone allowed to command this agent. */
  phoneE164: string;
  /** Service-role client: every query built from it MUST be pinned to `userId`. */
  db: SupabaseClient;
  /** Provider message id of the text being answered; seeds idempotency, never identity. */
  messageSid: string;
  now?: Date;
  /** The PUBLIC catalog (`getPublicListings`), loaded at most once per turn. */
  loadListings: () => Promise<MockProperty[]>;
};

export type ResidentPersonalAgentContextArgs = {
  residentUserId: string;
  messageSid: string;
  now?: Date;
  loadListings?: () => Promise<MockProperty[]>;
};

/**
 * The turn's context, or null when this owner can no longer be served: no account, no resident role
 * in `profile_roles`, no email, or a phone that is not (any longer) verified. Fails closed.
 */
export async function buildResidentPersonalAgentContext(
  db: SupabaseClient,
  args: ResidentPersonalAgentContextArgs,
): Promise<ResidentPersonalAgentContext | null> {
  const residentUserId = args.residentUserId.trim();
  if (!residentUserId) return null;
  const { data, error } = await db
    .from("profiles")
    .select("email, full_name, phone, phone_verified_at, role")
    .eq("id", residentUserId)
    .maybeSingle();
  if (error || !data) return null;
  const profile = data as { email?: unknown; full_name?: unknown; phone?: unknown; phone_verified_at?: unknown; role?: unknown };
  const email = String(profile.email ?? "").trim().toLowerCase();
  const phone = normalizeE164(String(profile.phone ?? ""));
  if (!email || !phone || !profile.phone_verified_at) return null;
  const isResident = await authorizeResidentRole(db as Parameters<typeof authorizeResidentRole>[0], {
    userId: residentUserId,
    legacyRole: typeof profile.role === "string" ? profile.role : null,
  });
  if (!isResident) return null;

  let cached: Promise<MockProperty[]> | null = null;
  const loadListings =
    args.loadListings ??
    (() => {
      cached ??= import("@/lib/public-listings.server").then((m) => m.getPublicListings());
      return cached;
    });

  return {
    kind: "resident_personal_agent",
    userId: residentUserId,
    landlordId: residentUserId,
    email,
    fullName: String(profile.full_name ?? "").trim(),
    phoneE164: phone,
    db,
    messageSid: args.messageSid,
    now: args.now,
    loadListings,
  };
}
