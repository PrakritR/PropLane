/**
 * Personal account link, pure half (design-1112 §5). A prospect who messaged a listing, or texted the PropLane
 * line, gets ONE link bound to their phone. It opens account creation with the phone already proven, and the new
 * account lands connected to the conversation and the home they asked about.
 *
 * The link is the existing phone-bound link service (`phone_bound_links`, purpose `account`, no code gate, 14 days):
 * a random token of which only the SHA-256 is stored. It names a workspace and a home, never a URL or a person.
 */

/** `phone_bound_links.target_type` of a personal account link. */
export const PERSONAL_LINK_TARGET_TYPE = "prospect";

const NO_PROPERTY = "-";
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function personalLinkTargetId(workspaceId: string, propertyId?: string | null): string {
  const property = String(propertyId ?? "").trim();
  return `${workspaceId.trim()}:${property && ID.test(property) ? property : NO_PROPERTY}`;
}

export function parsePersonalLinkTarget(value: string): { workspaceId: string; propertyId: string | null } | null {
  const text = String(value ?? "").trim();
  const cut = text.indexOf(":");
  if (cut < 1) return null;
  const workspaceId = text.slice(0, cut);
  const propertyId = text.slice(cut + 1);
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !ID.test(propertyId)) return null;
  return { workspaceId, propertyId: propertyId === NO_PROPERTY ? null : propertyId };
}

/** What the page draws before the account exists. Never carries the full phone or any conversation text. */
export type PersonalAccountPrefill = {
  houseLabel: string;
  /** The last four digits of the phone the link is bound to. */
  maskedPhone: string;
};

export type PersonalAccountInput = {
  fullName: string;
  /** Optional, only ever a claim: never the login. */
  email: string;
  /** Set server-side on a NEW account only; empty when the person continues with Google. */
  password: string;
  viaGoogle: boolean;
};
export type PersonalAccountInputResult = { ok: true; value: PersonalAccountInput } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
export const PERSONAL_PASSWORD_MIN = 8;
export const PERSONAL_PASSWORD_MAX = 72;

export function validatePersonalAccountInput(raw: unknown): PersonalAccountInputResult {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fullName = typeof r.fullName === "string" ? r.fullName.replace(/\s+/g, " ").trim() : "";
  if (fullName.length < 2 || fullName.length > 80) return { ok: false, error: "Enter your full name." };
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return { ok: false, error: "That email does not look right." };
  const viaGoogle = r.provider === "google";
  const password = typeof r.password === "string" ? r.password : "";
  if (!viaGoogle && (password.length < PERSONAL_PASSWORD_MIN || password.length > PERSONAL_PASSWORD_MAX)) {
    return { ok: false, error: `Choose a password of at least ${PERSONAL_PASSWORD_MIN} characters.` };
  }
  return { ok: true, value: { fullName, email, password: viaGoogle ? "" : password, viaGoogle } };
}

/** Where a new or returning prospect lands: the conversation, with the home they asked about. */
export const PERSONAL_LINK_LANDING_PATH = "/resident/communication";
