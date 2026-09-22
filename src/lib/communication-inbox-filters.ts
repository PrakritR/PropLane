import type { CommunicationAssistantPortal } from "@/lib/communication-assistant-inbox-list";
import type { ManagerAssistantWorkspace } from "@/lib/communication-manager-assistant-thread";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { countUnreadActiveCommunication } from "@/lib/communication-active-rows";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

/** True when a contact label looks like a phone number rather than a person/email. */
export function isPhoneLikeContact(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim();
  if (!v || v.includes("@")) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 10 && /^\+?[\d\s().-]+$/.test(v);
}

/** Inbox rows that belong in SMS (phone senders or SMS notice subjects). */
export function isSmsLikeInboxThread(thread: Pick<PersistedInboxThread, "from" | "email" | "subject">): boolean {
  if (isPhoneLikeContact(thread.from)) return true;
  if (isPhoneLikeContact(thread.email)) return true;
  const subject = String(thread.subject ?? "").toLowerCase();
  if (subject.includes("sms") && subject.includes("inbox")) return true;
  if (subject.includes("text from")) return true;
  return false;
}

/**
 * Email-channel threads only (exclude SMS-like rows).
 *
 * When the SMS Communication UI is hidden (A2P not yet cleared), pass
 * `{ keepSmsLike: true }` so inbound-SMS notices FALL THROUGH into the unified
 * conversation list instead of vanishing: they are normally routed to the SMS
 * panel, which is hidden, so filtering them here too would make an inbound text
 * invisible in both places. See `isSmsCommUiEnabled()` and the report's
 * `isSmsLikeInboxThread` warning.
 */
export function filterEmailInboxThreads<T extends Pick<PersistedInboxThread, "from" | "email" | "subject">>(
  threads: T[],
  opts?: { keepSmsLike?: boolean },
): T[] {
  if (opts?.keepSmsLike) return threads;
  return threads.filter((thread) => !isSmsLikeInboxThread(thread));
}

/** PropLane admin ops threads belong in the admin portal, not the manager Communication list. */
export function isPrimaryAdminInboxThread(
  thread: Pick<PersistedInboxThread, "from" | "email">,
): boolean {
  const email = String(thread.email ?? "").trim();
  const from = String(thread.from ?? "").trim();
  // `Boolean(...)`, not `email && …`: the `&&` form yields the empty STRING when
  // the field is blank, which is not the declared `boolean` return type.
  return Boolean(email && isPrimaryAdminEmail(email)) || Boolean(from && isPrimaryAdminEmail(from));
}

export function filterManagerCommunicationThreads<T extends Pick<PersistedInboxThread, "from" | "email" | "subject">>(
  threads: T[],
): T[] {
  return threads.filter((thread) => !isPrimaryAdminInboxThread(thread));
}

/** Phone the SMS delete route can send when the directory row is missing one. */
export function resolveSmsDeletePhone(input: {
  conversationId: string;
  targetPhone?: string | null;
  rowName?: string | null;
  rowSubtitle?: string | null;
}): string {
  const candidates = [input.targetPhone, input.rowName, input.rowSubtitle, input.conversationId];
  for (const value of candidates) {
    const trimmed = String(value ?? "").trim();
    if (isPhoneLikeContact(trimmed)) return trimmed;
  }
  const rawId = input.conversationId.trim();
  const digits = rawId.replace(/\D/g, "");
  if (digits.length >= 10) return rawId.startsWith("+") ? rawId : `+${digits}`;
  return String(input.targetPhone ?? "").trim();
}

/** Match a vendor detail inbox to that vendor's email or phone. */
export function threadMatchesVendorContact(
  thread: Pick<PersistedInboxThread, "from" | "email">,
  contact: { email?: string | null; phone?: string | null },
): boolean {
  const email = String(contact.email ?? "").trim().toLowerCase();
  if (email) {
    if (String(thread.email ?? "").trim().toLowerCase() === email) return true;
    if (String(thread.from ?? "").trim().toLowerCase() === email) return true;
  }
  const digits = String(contact.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    const emailDigits = String(thread.email ?? "").replace(/\D/g, "");
    const fromDigits = String(thread.from ?? "").replace(/\D/g, "");
    if (emailDigits.endsWith(last10) || fromDigits.endsWith(last10)) return true;
  }
  return false;
}

/**
 * Unread conversations Active would show. Thin alias of
 * `countUnreadActiveCommunication` (`@/lib/communication-active-rows`), kept
 * here so every existing import path keeps working — the real pipeline lives
 * there, lifted straight out of the Active list's own row-building code so the
 * badge can never drift from what Active actually renders.
 */
export function countVisibleUnreadCommunication(
  rows: PersistedInboxThread[],
  opts: {
    portal: CommunicationAssistantPortal;
    viewerId: string | null | undefined;
    workspace?: ManagerAssistantWorkspace | null;
    archivedSmsIds?: ReadonlySet<string>;
    smsUiEnabled?: boolean;
  },
): number {
  return countUnreadActiveCommunication(rows, {
    portal: opts.portal,
    viewerId: opts.viewerId,
    workspace: opts.workspace,
    archivedSmsIds: opts.archivedSmsIds,
    smsUiEnabled: opts.smsUiEnabled ?? false,
  });
}
