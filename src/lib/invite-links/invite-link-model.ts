/**
 * Shared, dependency-free model for shareable invite links.
 *
 * Client and server both need the expiry vocabulary and the "is this link still
 * usable" answer, so it lives here rather than in the server module — one
 * decision, not a client copy that drifts from the gate that enforces it.
 */

export type InviteLinkKind = "manager" | "vendor";

/** `kind` arrives from a request body — only the two real kinds are honoured. */
export function normalizeInviteLinkKind(raw: unknown): InviteLinkKind {
  return raw === "vendor" ? "vendor" : "manager";
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
