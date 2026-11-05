import { expect, it } from "vitest";
import { inspectSignupPhoneState } from "../helpers/signup-proof-phone-cleanup";
import type { SignupJournal } from "../helpers/signup-proof-journal";
const nonce = "a".repeat(32), actor = "11111111-1111-4111-8111-111111111111";
const journal: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z", actorId: actor };
const contact = { phone_e164: journal.phone, user_id: actor, display_name: null, first_seen_at: "2026-01-01T00:00:01Z", last_seen_at: "2026-01-01T00:00:02Z" };
it("accepts only a new exact contact and expired owned lock", () => {
  expect(inspectSignupPhoneState(journal, { contacts: [contact], challenges: [{ auth_user_id: actor, phone_e164: journal.phone, purpose: "sign_in", created_at: contact.first_seen_at }], locks: [{ key: `user:${actor}`, expires_at: contact.last_seen_at }] }, Date.parse("2026-01-01T00:00:03Z"))).toEqual({ lastSeenAt: contact.last_seen_at });
});
it("refuses foreign contacts, wrong challenges, and live locks", () => {
  for (const input of [{ contacts: [{ ...contact, user_id: "foreign" }], challenges: [], locks: [] }, { contacts: [contact], challenges: [{ auth_user_id: actor, phone_e164: journal.phone, purpose: "verify_phone", created_at: contact.first_seen_at }], locks: [] }, { contacts: [contact], challenges: [], locks: [{ key: `phone:${journal.phone}`, expires_at: "2027-01-01T00:00:00Z" }] }]) expect(() => inspectSignupPhoneState(journal, input, Date.parse("2026-01-01T00:00:03Z"))).toThrow("Signup phone cleanup refused.");
});
