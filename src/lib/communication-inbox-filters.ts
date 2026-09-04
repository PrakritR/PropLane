import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";

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
