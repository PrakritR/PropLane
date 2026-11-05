/** Pure phone-row checks, used before any bounded fixture contact cleanup. */
import type { SignupJournal } from "./signup-proof-journal";
type Contact = { phone_e164: unknown; user_id: unknown; display_name: unknown; first_seen_at: unknown; last_seen_at: unknown };
type Challenge = { auth_user_id: unknown; phone_e164: unknown; purpose: unknown; created_at: unknown };
type Lock = { key: unknown; expires_at: unknown };
export function inspectSignupPhoneState(journal: SignupJournal, input: { contacts: Contact[]; challenges: Challenge[]; locks: Lock[] }, now = Date.now()): { lastSeenAt: string | null } {
  const refuse = (): never => { throw new Error("Signup phone cleanup refused."); };
  if (!journal.actorId || input.contacts.length > 1 || !Number.isFinite(now)) refuse();
  const contact = input.contacts[0];
  if (contact && (contact.phone_e164 !== journal.phone || contact.user_id !== journal.actorId || contact.display_name !== null || typeof contact.first_seen_at !== "string" || !Number.isFinite(Date.parse(contact.first_seen_at)) || Date.parse(contact.first_seen_at) < Date.parse(journal.startedAt) || typeof contact.last_seen_at !== "string" || !Number.isFinite(Date.parse(contact.last_seen_at)) || Date.parse(contact.last_seen_at) < Date.parse(contact.first_seen_at))) refuse();
  for (const challenge of input.challenges) if (challenge.auth_user_id !== journal.actorId || challenge.phone_e164 !== journal.phone || challenge.purpose !== "sign_in" || typeof challenge.created_at !== "string" || !Number.isFinite(Date.parse(challenge.created_at)) || Date.parse(challenge.created_at) < Date.parse(journal.startedAt)) refuse();
  for (const lock of input.locks) if (![ `phone:${journal.phone}`, `user:${journal.actorId}` ].includes(String(lock.key)) || typeof lock.expires_at !== "string" || !Number.isFinite(Date.parse(lock.expires_at)) || Date.parse(lock.expires_at) > now) refuse();
  return { lastSeenAt: contact ? contact.last_seen_at as string : null };
}
