/** Pure, fail-closed checks shared by the synthetic signup phone fixture and offline tests. */
export type GuardManifest = { email: string; phone: string; fullName: string; tier: "pro" | "resident"; startedAt: string; actorId?: string };
const refused = (): never => { throw new Error("Signup proof guard refused."); };
export function assertManifest(m: GuardManifest, nonce: string, now = Date.now()): asserts m is GuardManifest & { actorId: string } {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !new RegExp(`^p8-(manager-${nonce}-(draft|listing)|resident-${nonce}-resident)@example\\.invalid$`).test(m.email) || !/^\+12065550(?:1[0-9]{2})$/.test(m.phone) || !["pro", "resident"].includes(m.tier) || (m.tier === "resident") !== m.email.includes("p8-resident-") || !m.actorId || !/^[a-f0-9-]{36}$/i.test(m.actorId) || !Number.isFinite(Date.parse(m.startedAt)) || Date.parse(m.startedAt) > now || now - Date.parse(m.startedAt) > 3_600_000) refused();
}
export function assertActor(m: GuardManifest & { actorId: string }, u: { id: string; email?: string; created_at: string; email_confirmed_at?: string | null; phone_confirmed_at?: string | null; app_metadata: Record<string, unknown> } | null) {
  const start = Date.parse(m.startedAt);
  if (!u || u.id !== m.actorId || u.email?.toLowerCase() !== m.email || !Number.isFinite(Date.parse(u.created_at)) || Date.parse(u.created_at) < start || !u.email_confirmed_at || !Number.isFinite(Date.parse(u.email_confirmed_at)) || Date.parse(u.email_confirmed_at) < start || u.app_metadata.proplane_email_onboarding !== true || u.phone_confirmed_at) refused();
}
export function assertProfile(m: GuardManifest & { actorId: string }, p: { id: string; email: string | null; full_name: string | null; phone: string | null; phone_verified_at: string | null } | null) {
  if (!p || p.id !== m.actorId || p.email !== m.email || p.full_name !== m.fullName || p.phone !== m.phone || p.phone_verified_at) refused();
}
export function assertRoles(m: GuardManifest, roles: Array<{ role: string }>) {
  if (roles.length !== 1 || roles[0]?.role !== (m.tier === "resident" ? "resident" : "manager")) refused();
}
export function assertPurchase(m: GuardManifest & { actorId: string }, managerId: string | null, purchases: Array<{ user_id: string | null; email: string; manager_id: string; tier: string | null; billing: string | null; stripe_checkout_session_id: string | null; stripe_subscription_id: string | null }>, peers: Array<{ id: string }>) {
  if (m.tier === "resident") { if (purchases.length) refused(); return; }
  const p = purchases[0];
  if (!managerId || peers.length !== 1 || peers[0]?.id !== m.actorId || purchases.length !== 1 || !p || p.user_id !== m.actorId || p.email !== m.email || p.manager_id !== managerId || p.tier !== "pro" || p.billing !== "trial" || !p.stripe_checkout_session_id?.startsWith("axis_intent_") || p.stripe_subscription_id) refused();
}
export function assertWorkspace(m: GuardManifest & { actorId: string }, owned: Array<{ owner_user_id: string; created_at: string }>, foreignLinks: number, links: number, testMemberships: number, testOwned: number) {
  if (foreignLinks || links || testMemberships || testOwned || owned.some((w) => w.owner_user_id !== m.actorId || !Number.isFinite(Date.parse(w.created_at)) || Date.parse(w.created_at) < Date.parse(m.startedAt))) refused();
}
export function assertPhoneAvailability(enabled: boolean, owners: number, contacts: number, foreignAuth: boolean, foreignProfiles: boolean) {
  if (!enabled || owners || contacts || foreignAuth || foreignProfiles) refused();
}
export function assertDelivery(expectedActor: string, expectedPhone: string, actor: string | undefined, phone: string, context: { actorUserId: string; managerUserId: string } | null, sends: number) {
  if (!expectedActor || !expectedPhone || phone !== expectedPhone || actor !== expectedActor || context?.actorUserId !== expectedActor || context.managerUserId !== expectedActor || sends !== 0) refused();
}
