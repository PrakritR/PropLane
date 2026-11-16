import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneSession, phoneOwners } from "@/lib/auth/phone-auth.server";
import { smsProvenSessionAllowed } from "@/lib/auth/sms-proven-session.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { provisionSmsSignupAccount } from "@/lib/one-number/signup/provision.server";
import { claimLink, releaseLink } from "@/lib/personal-link/complete.server";
import { maskLast4 } from "@/lib/personal-link/open.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { linkAccountToProspectRecord } from "@/lib/prospect-spine/index.server";
import { loadGuestTourListing } from "@/lib/tour-guest-prospect.server";
import { linkTourInquiryToResident, loadTourInquiryById } from "@/lib/tour-resident-link.server";
import {
  GUEST_TOUR_LINK_TARGET,
  guestSignupLandingPath,
  isGuestSignupTarget,
  parseGuestSignupTarget,
  type GuestSignupLinkKind,
} from "./model";

export type GuestSignupDeps = {
  findOwners?: (db: SupabaseClient, phone: string) => Promise<string[]>;
  provision?: typeof provisionSmsSignupAccount;
  sessionAllowed?: (db: SupabaseClient, userId: string) => Promise<boolean>;
  mintSession?: (db: SupabaseClient, userId: string) => Promise<{ access_token: string; refresh_token: string } | null>;
  link?: typeof linkAccountToProspectRecord;
  linkTour?: typeof linkTourInquiryToResident;
  now?: () => Date;
};

export type GuestSignupResult =
  | { ok: true; userId: string; created: boolean; session: { access_token: string; refresh_token: string } | null; nextPath: string; kind: GuestSignupLinkKind }
  | { ok: false; status: 404 | 409 | 503; error: string };

const EXPIRED = "This link has expired.";
const SIGN_IN = "Sign in to continue.";
const TRY_AGAIN = "We could not finish that just now. Try again in a moment.";
const FALLBACK_NAME = "PropLane renter";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** What the page draws before the button is pressed: the home and the last four digits, never the application. */
export async function openGuestSignupLink(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "purpose" | "targetType" | "targetId" | "workspaceId" | "phoneKey">,
): Promise<{ ok: true; houseLabel: string; maskedPhone: string; kind: GuestSignupLinkKind } | { ok: false }> {
  if (link.purpose !== "account" || !isGuestSignupTarget(link.targetType) || !link.workspaceId) return { ok: false };
  const target = parseGuestSignupTarget(link.targetId);
  if (!target || target.workspaceId !== link.workspaceId || !target.subjectId) return { ok: false };
  const kind: GuestSignupLinkKind = link.targetType === GUEST_TOUR_LINK_TARGET ? "tour" : "apply";
  const propertyId = kind === "tour" ? text((await loadTourInquiryById(db, target.subjectId).catch(() => null))?.propertyId) : target.subjectId;
  const listing = propertyId ? await loadGuestTourListing(db, propertyId) : null;
  // The home must still be a live listing of the link's own workspace.
  if (!listing || listing.workspaceId !== link.workspaceId) return { ok: false };
  return { ok: true, houseLabel: listing.propertyLabel, maskedPhone: maskLast4(link.phoneKey), kind };
}

async function mintSessionFor(db: SupabaseClient, userId: string) {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return mintPhoneSession(db, data.user);
}

/** The name the renter already typed (the held application's legal name, or the tour request's name), by the link's phone. */
async function knownName(db: SupabaseClient, kind: GuestSignupLinkKind, subjectId: string, phoneE164: string, now: Date): Promise<string> {
  if (kind === "tour") {
    const inquiry = await loadTourInquiryById(db, subjectId).catch(() => null);
    return text(inquiry?.name);
  }
  const { data } = await db
    .from("guest_application_drafts")
    .select("draft")
    .eq("status", "pending")
    .eq("property_id", subjectId)
    .eq("phone_e164", phoneE164)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const draft = ((data ?? [])[0] as Row | undefined)?.draft;
  return draft && typeof draft === "object" ? text((draft as Row).fullLegalName) : "";
}

/**
 * Finish a guest sign-in link. Possession of the link IS the proof of the phone it was texted to (the number the renter
 * typed on their own application or tour request), the way the emailed `token_hash` link is the proof of a mailbox. In order:
 *
 *  1. the link is spent atomically BEFORE anything is created (two simultaneous opens cannot both win, a replay reads as
 *     expired); a refusal or crash before the account exists gives it back;
 *  2. the account for this phone: none -> `provisionSmsSignupAccount` (a phone-only resident whose phone is VERIFIED by
 *     the same bind the phone code uses, so no later phone code is asked); exactly one holder whose credentials are no
 *     stronger than a phone (`smsProvenSessionAllowed`) -> that account is signed in, never a second one; anything else ->
 *     the ordinary sign-in, saying nothing about why;
 *  3. `linkAccountToProspectRecord` (refuses unless the phone is verified and owned by exactly this account) and, for a
 *     tour, the tour is linked to the account so it shows under Tour;
 *  4. a session is minted. The application is not touched: the portal apply page claims the held draft (the session's
 *     VERIFIED phone must be the one the draft names) and submits it through the ordinary signed-in write.
 */
export async function completeGuestSignup(db: SupabaseClient, input: { link: PhoneBoundLink }, deps: GuestSignupDeps = {}): Promise<GuestSignupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await claimLink(db, input.link.id, now);
  if (!claimed) return { ok: false, status: 404, error: EXPIRED };
  let finished = false;
  try {
    const result = await finish(db, input.link, deps, now);
    finished = result.ok;
    return result;
  } finally {
    if (!finished) await releaseLink(db, input.link.id);
  }
}

async function finish(db: SupabaseClient, link: PhoneBoundLink, deps: GuestSignupDeps, now: Date): Promise<GuestSignupResult> {
  const opened = await openGuestSignupLink(db, link);
  if (!opened.ok) return { ok: false, status: 404, error: EXPIRED };
  const target = parseGuestSignupTarget(link.targetId);
  const phone = normalizeE164(link.phoneKey);
  if (!target?.subjectId || !phone) return { ok: false, status: 404, error: EXPIRED };
  const { kind } = opened;
  const subjectId = target.subjectId;

  const owners = await (deps.findOwners ?? phoneOwners)(db, phone).catch(() => null);
  if (owners === null) return { ok: false, status: 503, error: TRY_AGAIN };
  const sessionAllowed = deps.sessionAllowed ?? smsProvenSessionAllowed;

  let userId: string | null = null;
  let created = false;
  if (owners.length === 0) {
    const fullName = (await knownName(db, kind, subjectId, phone, now).catch(() => "")) || FALLBACK_NAME;
    const provisioned = await (deps.provision ?? provisionSmsSignupAccount)(db, { phoneE164: phone, role: "resident", answers: { fullName, home: opened.houseLabel } });
    if (provisioned.ok) {
      userId = provisioned.userId;
      created = true;
    } else if (provisioned.reason === "exists" && provisioned.existingUserId) {
      userId = provisioned.existingUserId;
    } else {
      return { ok: false, status: 503, error: TRY_AGAIN };
    }
  } else if (owners.length === 1) {
    userId = owners[0]!;
  } else {
    return { ok: false, status: 409, error: SIGN_IN };
  }
  if (!created && !(await sessionAllowed(db, userId).catch(() => false))) return { ok: false, status: 409, error: SIGN_IN };

  try {
    await (deps.link ?? linkAccountToProspectRecord)(db, { userId, phoneE164: phone });
  } catch (error) {
    console.error("[guest-signup-link] could not link the account to its history", error instanceof Error ? error.name : "unknown");
  }

  if (kind === "tour") {
    // The inquiry's own phone must be the link's phone (it is, by construction); its email is the tour's own contact,
    // so the record link is the one the inquiry already names.
    const inquiry = await loadTourInquiryById(db, subjectId).catch(() => null);
    const inquiryPhone = inquiry ? normalizeE164(text(inquiry.phone)) : null;
    const email = inquiry ? text(inquiry.email).toLowerCase() : "";
    if (inquiry && inquiryPhone === phone && email.includes("@")) {
      await (deps.linkTour ?? linkTourInquiryToResident)(db, { userId, inquiryId: subjectId, email }).catch(() => undefined);
    }
  }

  let session: { access_token: string; refresh_token: string } | null = null;
  try {
    if (created || (await sessionAllowed(db, userId))) session = deps.mintSession ? await deps.mintSession(db, userId) : await mintSessionFor(db, userId);
  } catch {
    session = null;
  }
  return { ok: true, userId, created, session, nextPath: guestSignupLandingPath(kind, subjectId), kind };
}
