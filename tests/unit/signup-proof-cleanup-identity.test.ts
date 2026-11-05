import { expect, it } from "vitest";
import { assertCleanupSignupActor } from "../helpers/signup-proof-cleanup-identity";
import type { SignupJournal } from "../helpers/signup-proof-journal";
const actor = "11111111-1111-4111-8111-111111111111", nonce = "a".repeat(32);
const journal: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z", actorId: actor };
const user = { id: actor, email: journal.email, created_at: "2026-01-01T00:00:01Z", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] };
it("accepts the newly bound exact phone only alongside the original email identity", () => {
  expect(() => assertCleanupSignupActor(journal, user)).not.toThrow();
  expect(() => assertCleanupSignupActor(journal, { ...user, phone: "12065550100", identities: [...user.identities, { provider: "phone", identity_data: { phone: "12065550100" } }] })).not.toThrow();
  for (const suspect of [{ ...user, identities: [] }, { ...user, identities: [{ provider: "google" }] }, { ...user, phone: "12065550101", identities: [...user.identities, { provider: "phone", identity_data: { phone: "12065550101" } }] }, { ...user, id: "foreign" }]) expect(() => assertCleanupSignupActor(journal, suspect)).toThrow("Signup cleanup identity refused.");
});
