/**
 * Shared, dependency-free model for shareable invite links.
 *
 * Client and server both need the expiry vocabulary and the "is this link still
 * usable" answer, so it lives here rather than in the server module — one
 * decision, not a client copy that drifts from the gate that enforces it.
 */

export type InviteLinkKind = "manager" | "vendor" | "resident";

/** Typed refusal when a share-link opener has no manager portal role yet. */
export const MANAGER_ROLE_REQUIRED_CODE = "manager_role_required";

/**
 * `kind` arrives from a request body — only the real kinds are honoured.
 *
 * An ALLOWLIST, and it must stay one. The fallback is `manager`, which is the
 * kind with the strictest gates in front of it (ownership re-derivation and a
 * paid-plan check), so an unrecognised value lands somewhere refusals happen
 * rather than on the resident path, which by design has no plan gate.
 */
export function normalizeInviteLinkKind(raw: unknown): InviteLinkKind {
  if (raw === "vendor") return "vendor";
  if (raw === "resident") return "resident";
  return "manager";
}

/**
 * The expiry choices, in the order the picker shows them.
 *
 * `never` is deliberately available and deliberately last: a manager running a
 * standing "join my team" link is a real case, and pretending otherwise just
 * produces links people re-mint forever. It is the one option the UI marks.
 */
export const INVITE_LINK_EXPIRY_OPTIONS = [
  { id: "30m", label: "30 minutes", minutes: 30 },
  { id: "1h", label: "1 hour", minutes: 60 },
  { id: "6h", label: "6 hours", minutes: 60 * 6 },
  { id: "12h", label: "12 hours", minutes: 60 * 12 },
  { id: "1d", label: "1 day", minutes: 60 * 24 },
  { id: "7d", label: "7 days", minutes: 60 * 24 * 7 },
  { id: "30d", label: "30 days", minutes: 60 * 24 * 30 },
  { id: "never", label: "Never", minutes: null },
] as const;

export type InviteLinkExpiryId = (typeof INVITE_LINK_EXPIRY_OPTIONS)[number]["id"];

export const DEFAULT_INVITE_LINK_EXPIRY: InviteLinkExpiryId = "7d";

/** `null` = never expires. Anything unrecognised falls back to the default. */
export function expiryIsoForOption(
  id: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const fallback = INVITE_LINK_EXPIRY_OPTIONS.find((o) => o.id === DEFAULT_INVITE_LINK_EXPIRY)!;
  const option = INVITE_LINK_EXPIRY_OPTIONS.find((o) => o.id === id) ?? fallback;
  if (option.minutes == null) return null;
  return new Date(now.getTime() + option.minutes * 60_000).toISOString();
}

export const INVITE_LINK_USE_OPTIONS = [
  { id: "1", label: "1 use", maxUses: 1 },
  { id: "5", label: "5 uses", maxUses: 5 },
  { id: "10", label: "10 uses", maxUses: 10 },
  { id: "25", label: "25 uses", maxUses: 25 },
  { id: "unlimited", label: "No limit", maxUses: null },
] as const;

export type InviteLinkUseId = (typeof INVITE_LINK_USE_OPTIONS)[number]["id"];

export const DEFAULT_INVITE_LINK_USES: InviteLinkUseId = "1";

/** `null` = unlimited. Anything unrecognised falls back to single use. */
export function maxUsesForOption(id: string | null | undefined): number | null {
  const fallback = INVITE_LINK_USE_OPTIONS.find((o) => o.id === DEFAULT_INVITE_LINK_USES)!;
  return (INVITE_LINK_USE_OPTIONS.find((o) => o.id === id) ?? fallback).maxUses;
}

export type InviteLinkState = {
  expiresAt?: string | null;
  revokedAt?: string | null;
  maxUses?: number | null;
  usedCount?: number | null;
};

export type InviteLinkUnusableReason = "revoked" | "expired" | "exhausted";

/**
 * Why a link cannot be redeemed, or `null` when it can.
 *
 * Order matters for the message a person sees: a revoked link is a decision
 * someone made, an expired one is a deadline, and an exhausted one means they
 * were too late rather than unwelcome.
 */
export function inviteLinkUnusableReason(
  link: InviteLinkState,
  now: Date = new Date(),
): InviteLinkUnusableReason | null {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now.getTime()) return "expired";
  const max = link.maxUses;
  if (max != null && (link.usedCount ?? 0) >= max) return "exhausted";
  return null;
}

export function inviteLinkUnusableMessage(reason: InviteLinkUnusableReason): string {
  switch (reason) {
    case "revoked":
      return "This invite link was turned off. Ask for a new one.";
    case "expired":
      return "This invite link has expired. Ask for a new one.";
    case "exhausted":
      return "This invite link has already been used the maximum number of times. Ask for a new one.";
  }
}

/** Public URL a person opens. The token is the path segment, never a query. */
export function inviteLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

/**
 * Workspace code: a short, human-typeable alias of ONE invite link
 * ("SH-7K4Q" = two letters from the workspace name + four base32 characters).
 * It resolves to the same row as the raw token, so expiry, use budget and
 * revocation are the link's own. No 0/O/1/I so it survives being read aloud.
 */
export const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function inviteCodePrefix(workspaceName: string | null | undefined): string {
  const letters = String(workspaceName ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const words = String(workspaceName ?? "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const initials = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : letters.slice(0, 2);
  return (initials + "PL").slice(0, 2);
}

/** `random` returns an int in [0, n); injectable for tests. */
export function generateInviteCode(
  workspaceName: string | null | undefined,
  random: (n: number) => number = (n) => Math.floor(Math.random() * n),
): string {
  let tail = "";
  for (let i = 0; i < 4; i += 1) tail += INVITE_CODE_ALPHABET[random(INVITE_CODE_ALPHABET.length)];
  return `${inviteCodePrefix(workspaceName)}-${tail}`;
}

export type ParsedInviteInput = { kind: "code"; code: string } | { kind: "token"; token: string };

/**
 * What a person pastes or types into a join box: a full link, a bare token or a
 * workspace code. Anything that is not obviously a code is treated as a token
 * (the hash lookup refuses it uniformly).
 */
export function parseInviteInput(raw: unknown): ParsedInviteInput | null {
  let text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const urlMatch = text.match(/\/invite\/([^/?#\s]+)/i);
  if (urlMatch) {
    try {
      text = decodeURIComponent(urlMatch[1]);
    } catch {
      text = urlMatch[1];
    }
    return text ? { kind: "token", token: text } : null;
  }
  const squashed = text.replace(/[\s-]+/g, "").toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(squashed)) {
    return { kind: "code", code: `${squashed.slice(0, 2)}-${squashed.slice(2)}` };
  }
  return { kind: "token", token: text };
}
