/**
 * The conversation key - client-safe, pure.
 *
 * ONE conversation per person per workspace. A person is identified by, in
 * order of strength:
 *
 *   1. their ACCOUNT (resident or vendor) when it is linked to the workspace
 *      (a lease, an application or a vendor record)        -> acct:<uuid>
 *   2. their PHONE, strict E.164                            -> tel:+15105551234
 *   3. their EMAIL, lower-cased                             -> mail:<email>
 *
 * and, on the resident / vendor side of a conversation, the workspace they are
 * talking to                                                 -> ws:<workspace uuid>
 *
 * Linking rules (the reason this file exists as pure code with a table test):
 *
 *   - A phone links to an account ONLY if that account verified the phone
 *     (`phone_verified_at`). A phone merely typed into a form, or sitting on an
 *     unverified profile, never joins a person to an account.
 *   - If two accounts in the workspace verified the same phone, NOTHING merges:
 *     the conversation stays a phone conversation and is flagged
 *     `ambiguous_phone` so the manager chooses.
 *   - A phone/email pair on one record is never fused into one identity unless
 *     an account vouches for both.
 *   - Only `normalizeE164` decides what a valid phone is.
 *
 * The DB lookups that produce `accounts` live in `conversation-key.server.ts`;
 * this module is the decision.
 */
import { normalizeE164 } from "@/lib/phone-e164";

export type ConversationKeyKind = "account" | "phone" | "email" | "workspace";

/** Rows without a workspace (a vendor's own work identity, admin) share this sentinel so uniqueness still holds. */
export const PERSONAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export type ConversationFlag = {
  reason: "ambiguous_phone" | "identity_conflict";
  /** Accounts that could each claim the person. Never merged. */
  accountIds: string[];
  phone?: string;
};

/** An account that might be the person, already filtered by the caller's lookup. */
export type AccountCandidate = {
  id: string;
  email?: string | null;
  phone?: string | null;
  /** `profiles.phone_verified_at` is set. */
  phoneVerified: boolean;
  /** Linked to THIS workspace by a lease, an application or a vendor record. */
  linked: boolean;
};

export type DerivedConversationKey = {
  /** Strongest key, or null when nothing identifies the person (never merge then). */
  key: string | null;
  kind: ConversationKeyKind | null;
  /** Every key the SAME person may already be stored under, strongest first. */
  keys: string[];
  flagged: ConversationFlag | null;
};

export function accountKey(userId: string): string {
  return `acct:${userId.trim()}`;
}
export function phoneKey(e164: string): string {
  return `tel:${e164}`;
}
export function emailKey(email: string): string {
  return `mail:${email.trim().toLowerCase()}`;
}
export function workspaceKey(workspaceId: string): string {
  return `ws:${workspaceId.trim()}`;
}

export function conversationKeyKind(key: string | null | undefined): ConversationKeyKind | null {
  const value = String(key ?? "");
  if (value.startsWith("acct:")) return "account";
  if (value.startsWith("tel:")) return "phone";
  if (value.startsWith("mail:")) return "email";
  if (value.startsWith("ws:")) return "workspace";
  return null;
}

function cleanEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.includes("@") ? email : "";
}

export function deriveConversationKey(input: {
  /** An account id the writer already knows (a profile it just read). */
  accountId?: string | null;
  email?: string | null;
  phone?: string | null;
  accounts: readonly AccountCandidate[];
}): DerivedConversationKey {
  const email = cleanEmail(input.email);
  const phone = normalizeE164(input.phone);
  const knownId = String(input.accountId ?? "").trim();
  const linked = input.accounts.filter((account) => account.linked);

  // Accounts the writer named directly: by id or by the email on the record.
  const named = linked.filter(
    (account) =>
      (knownId && account.id === knownId) || (email && cleanEmail(account.email) === email),
  );
  const namedIds = [...new Set(named.map((account) => account.id))];

  // Accounts that VERIFIED this phone. An unverified match never counts.
  const phoneOwners = phone
    ? linked.filter((account) => account.phoneVerified && normalizeE164(account.phone) === phone)
    : [];
  const phoneOwnerIds = [...new Set(phoneOwners.map((account) => account.id))];

  const emailAlternate = (account: AccountCandidate | undefined): string[] => {
    const own = cleanEmail(account?.email);
    return own ? [emailKey(own)] : email ? [emailKey(email)] : [];
  };

  if (namedIds.length >= 1) {
    // The writer named a specific account (id wins over email if they disagree).
    const chosen = (knownId && named.find((account) => account.id === knownId)) || named[0]!;
    const keys = [accountKey(chosen.id)];
    // The phone joins only when this very account verified it.
    if (phone && phoneOwnerIds.includes(chosen.id)) keys.push(phoneKey(phone));
    keys.push(...emailAlternate(chosen));
    const conflicting = [...new Set([...namedIds, ...phoneOwnerIds.filter((id) => id !== chosen.id)])];
    const flagged: ConversationFlag | null =
      conflicting.length > 1
        ? { reason: "identity_conflict", accountIds: conflicting, ...(phone ? { phone } : {}) }
        : null;
    return { key: keys[0]!, kind: "account", keys: [...new Set(keys)], flagged };
  }

  if (phone) {
    if (phoneOwnerIds.length === 1) {
      const owner = phoneOwners[0]!;
      const keys = [accountKey(owner.id), phoneKey(phone), ...emailAlternate(owner)];
      return { key: keys[0]!, kind: "account", keys: [...new Set(keys)], flagged: null };
    }
    if (phoneOwnerIds.length > 1) {
      // Two accounts verified the same number: nothing merges, the manager chooses.
      return {
        key: phoneKey(phone),
        kind: "phone",
        keys: [phoneKey(phone)],
        flagged: { reason: "ambiguous_phone", accountIds: phoneOwnerIds, phone },
      };
    }
    return { key: phoneKey(phone), kind: "phone", keys: [phoneKey(phone)], flagged: null };
  }

  if (email) return { key: emailKey(email), kind: "email", keys: [emailKey(email)], flagged: null };
  return { key: null, kind: null, keys: [], flagged: null };
}

/**
 * Is the stored thread the one this recipient belongs to? The server-side reply
 * check: a reply written into thread T and delivered to recipient R must be the
 * SAME person. A thread without a key is judged by the legacy email it was
 * stored under, never waved through.
 */
export function threadMatchesRecipient(input: {
  threadKey?: string | null;
  threadEmail?: string | null;
  recipientKeys: readonly string[];
  recipientEmail: string;
}): boolean {
  const threadKey = String(input.threadKey ?? "").trim();
  if (threadKey) return input.recipientKeys.includes(threadKey);
  const stored = cleanEmail(input.threadEmail);
  return Boolean(stored) && stored === cleanEmail(input.recipientEmail);
}

/**
 * The value two list rows (an in-app thread and an SMS conversation) share when
 * they are the same person in the same workspace: `ck:<workspace>:<key>`.
 */
export function conversationJoinKey(
  workspaceId: string | null | undefined,
  key: string | null | undefined,
): string | undefined {
  const value = String(key ?? "").trim();
  if (!value) return undefined;
  return `ck:${String(workspaceId ?? "").trim()}:${value}`;
}
