/** Pure identity guard for a cleanup actor. This does not authorize deletion. */
import type { SignupJournal } from "./signup-proof-journal";
type AuthIdentity = { provider?: string; identity_data?: { phone?: unknown } | null };
type AuthUser = { id: string; email?: string; phone?: string; created_at: string; app_metadata: Record<string, unknown>; identities?: AuthIdentity[] };
export function assertCleanupSignupActor(journal: SignupJournal, user: AuthUser | null): void {
  const refuse = (): never => { throw new Error("Signup cleanup identity refused."); };
  if (!journal.actorId || !user || user.id !== journal.actorId || user.email?.toLowerCase() !== journal.email || user.app_metadata?.proplane_email_onboarding !== true || !Number.isFinite(Date.parse(user.created_at)) || Date.parse(user.created_at) < Date.parse(journal.startedAt) || !Array.isArray(user.identities) || !user.identities.length) refuse();
  const providers = user.identities.map((entry) => entry.provider);
  if (providers.filter((provider) => provider === "email").length !== 1 || providers.filter((provider) => provider === "phone").length > 1 || providers.some((provider) => provider !== "email" && provider !== "phone")) refuse();
  const phoneIdentity = user.identities.find((entry) => entry.provider === "phone");
  if (phoneIdentity && (user.phone?.replace(/\D/g, "") !== journal.phone.slice(1) || String(phoneIdentity.identity_data?.phone ?? "").replace(/\D/g, "") !== journal.phone.slice(1))) refuse();
  if (!phoneIdentity && user.phone) refuse();
}
