/**
 * One row per person: a text thread and an email thread are the same person when ONE workspace's own records tie the
 * phone to the email (the newest tour request or application that names both). Pure; display-only. A reply still goes
 * to the address / channel it names, and a pairing in another workspace never joins anything here.
 */
import { normalizeE164 } from "@/lib/phone-e164";

export type PhoneEmailEvidence = {
  /** The workspace owner the record belongs to. */
  ownerUserId: string;
  phone: string;
  email: string;
  /** When the record was filed (ms); the newest wins. */
  atMs: number;
};

export function emailForPhoneInWorkspace(
  evidence: readonly PhoneEmailEvidence[],
  ownerUserId: string,
  phone: string | null | undefined,
): string | null {
  const wanted = normalizeE164(phone ?? "");
  const owner = ownerUserId.trim();
  if (!wanted || !owner) return null;
  let best: PhoneEmailEvidence | null = null;
  for (const item of evidence) {
    if (item.ownerUserId !== owner) continue;
    if (normalizeE164(item.phone) !== wanted) continue;
    const email = item.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    if (!best || item.atMs >= best.atMs) best = { ...item, email };
  }
  return best ? best.email : null;
}
