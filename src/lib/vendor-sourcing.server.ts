import "server-only";
import { loadPublicVendorServiceFacts, projectPublicProblemSummary } from "@/lib/vendor-quote-public-facts.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveVendorOutreachIdentity, vendorQuoteSenderMatches } from "@/lib/vendor-outreach-identity.server";
import { dispatchVendorQuoteEmail } from "@/lib/vendor-quote-email.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import { vendorCapabilitiesMatchCategory } from "@/lib/work-order-taxonomy";
import { suggestVendorsForWorkOrder } from "@/lib/work-order-auto-match";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { searchVendorSourcingWeb } from "@/lib/vendor-sourcing-search.server";
import { normalizeConsentPhone, readScopedSmsConsentState, readSmsSuppressionState } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { isEmergencyWorkOrder } from "@/lib/work-order-dispatch";
import { resolveServiceAutomationSettingsForRow } from "@/lib/service-automation-settings.server";
import { createSettingsScopeCache } from "@/lib/settings/scope-resolver.server";

type Job = { id: string; work_order_id: string; manager_user_id: string; state: string; stage: number; lease_token: string; attempts: number; notified_state: string | null };
type Contact = { name: string; trade: string; phone: string | null; email: string; sourceUrl?: string; vendorUserId?: string | null; city?: string; phoneEvidence?: unknown; resultRank?: number; fetchedAt?: string; coverage?: string; emailEvidence?: unknown };
type Candidate = { id: string; job_id: string; manager_user_id: string; source: string; contact: Contact; dedupe_key: string; stage: number; source_directory_id: string | null; local_directory_id: string | null; proposal_id: string | null; status: string; reason: string | null; expires_at: string | null; outbox_id: string | null };
const sourceNames = ["roster", "shared", "web"] as const;
export const VENDOR_QUOTE_SMS_PURPOSE = "vendor_quote_request";
export function sourcingDedupeKey(contact: Contact) {
  if (contact.vendorUserId) return `user:${contact.vendorUserId}`;
  const phone = normalizeE164(contact.phone); if (phone) return `phone:${phone}`;
  let domain = ""; try { domain = new URL(contact.sourceUrl || "").hostname.replace(/^www\./, ""); } catch { /* no website */ }
  return `business:${domain}:${contact.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}
export function sourcingStopReason(row: Record<string, unknown>, proposals: { manager_takeover?: boolean; accepted_bid_id?: string | null; status: string }[]) {
  if (row.bucket !== "open" || row.vendorId || row.selfAssigned) return "Service assigned, closed or cancelled";
  if (proposals.some((p) => p.manager_takeover || p.accepted_bid_id || p.status === "approved")) return "Manager took over or approved a visit";
  return null;
}
export function sourcingProblemSummary(row: DemoManagerWorkOrderRow) {
  return projectPublicProblemSummary(row as unknown as Record<string, unknown>) ?? "Problem not specified";
}
function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
async function transition(db: SupabaseClient, job: Job, patch: Record<string, unknown>) {
  const { data, error } = await db.rpc("transition_vendor_sourcing", { p_job_id: job.id, p_lease_token: job.lease_token, p_patch: patch }); check(error);
  if (!data) throw new Error("Sourcing lease lost");
}
async function candidateUpdate(db: SupabaseClient, job: Job, id: string, patch: Record<string, unknown>) {
  const { error } = await db.rpc("update_vendor_sourcing_candidate", { p_candidate_id: id, p_lease_token: job.lease_token, p_patch: patch }); check(error);
}

async function candidates(db: SupabaseClient, job: Job): Promise<Candidate[]> {
  const { data, error } = await db.from("vendor_sourcing_candidates").select("*").eq("job_id", job.id).order("created_at"); check(error); return (data ?? []) as Candidate[];
}
async function discover(db: SupabaseClient, job: Job, row: DemoManagerWorkOrderRow, location: { city?: string; zip?: string }) {
  if (job.stage === 2) {
    const found = await searchVendorSourcingWeb({ category: String(row.category), ...location });
    if (found.status !== "available") throw new Error(`Web search unavailable: ${found.reason}`);
    return found.candidates.map((c) => ({ contact: { name: c.name, trade: String(row.category), phone: c.normalizedPhone, email: c.emailEvidence?.email || "", emailEvidence: c.emailEvidence, sourceUrl: c.url, phoneEvidence: c.phoneEvidence, resultRank: c.resultRank, fetchedAt: c.fetchedAt, coverage: "Search result; service area unverified" } as Contact, source_directory_id: null as string | null }));
  }
  let query = db.from("manager_vendor_records").select("id,manager_user_id,vendor_user_id,row_data");
  query = job.stage === 0 ? query.eq("manager_user_id", job.manager_user_id) : query.eq("row_data->>sharedWithManagers", "true").neq("manager_user_id", job.manager_user_id);
  const { data, error } = await query.order("id").limit(200); check(error);
  const records = (data ?? []).filter((v) => v.row_data?.active !== false);
  let selected = records;
  if (job.stage === 0) {
    const ranked = suggestVendorsForWorkOrder({ ...row, propertyId: row.propertyId || row.assignedPropertyId, managerUserId: job.manager_user_id }, records.map((v) => ({ ...v.row_data, id: v.id, managerUserId: v.manager_user_id } as ManagerVendorRow)));
    selected = ranked.flatMap((r) => records.filter((v) => v.id === r.vendorId));
  } else selected = records.filter((v) => vendorCapabilitiesMatchCategory(v.row_data?.trades?.length ? v.row_data.trades : [v.row_data?.trade || ""], row.category!))
    .filter((v) => { const city = String(v.row_data?.city || "").toLowerCase(); const zip = String(v.row_data?.zip || v.row_data?.zipCode || ""); return (!city && !zip) || Boolean(location.city && city === location.city.toLowerCase()) || Boolean(location.zip && zip === location.zip); });
  return selected.map((v) => ({ source_directory_id: String(v.id), contact: { name: String(v.row_data?.name || "Vendor"), trade: String(v.row_data?.trade || ""), phone: normalizeE164(v.row_data?.phone), email: String(v.row_data?.email || ""), vendorUserId: v.vendor_user_id || null, coverage: v.row_data?.city || v.row_data?.zip ? "Directory location match" : "Service area unknown" } as Contact }));
}
/** Page enrollment is limited to this candidate and sender, never future jobs. */
async function quoteConsentMatchesCandidate(db: SupabaseClient, job: { manager_user_id: string; work_order_id: string }, candidateId: string, phone: string, conversationKey: string) {
  const sender = await resolveVendorOutreachIdentity(db, job.manager_user_id, job.work_order_id, "sms");
  if (!sender) return false;
  const { data: events, error } = await db.from("sms_consent_events").select("source,evidence,event_type")
    .eq("recipient_phone_key", normalizeConsentPhone(phone)).eq("manager_user_id", job.manager_user_id)
    .eq("purpose", VENDOR_QUOTE_SMS_PURPOSE).eq("send_class", "automated").eq("conversation_key", conversationKey)
    .order("occurred_at", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  check(error);
  const event = events?.[0];
  if (event?.source !== "verified_vendor_quote_inbound_challenge") return true;
  if (event.event_type !== "granted" || event.evidence?.candidateId !== candidateId) return false;
  if (!sender.email) return false;
  const { data: grant, error: grantError } = await db.from("vendor_quote_sms_consent_events").select("capability_id,work_phone,messaging_service_sid,revoked_at")
    .eq("candidate_id", candidateId).eq("phone_e164", phone).is("revoked_at", null).order("granted_at", { ascending: false }).limit(1).maybeSingle();
  check(grantError); if (!grant) return false;
  const { data: cap, error: capError } = await db.from("vendor_quote_contact_capabilities").select("manager_user_id,work_order_id,candidate_id,sender_mode,sender_version,sender_snapshot,revoked_at,consumed_at,expires_at").eq("id", grant.capability_id).maybeSingle(); check(capError);
  return Boolean(cap && !cap.revoked_at && !cap.consumed_at && Date.parse(cap.expires_at) > Date.now() && cap.manager_user_id === job.manager_user_id && cap.work_order_id === job.work_order_id && cap.candidate_id === candidateId && sender.mode === cap.sender_mode && sender.version === cap.sender_version && vendorQuoteSenderMatches(sender, cap.sender_snapshot) && sender.workPhone === grant.work_phone && sender.messagingServiceSid === grant.messaging_service_sid);
}

/** No consent/invitation is manufactured here. Imports become quote-only portal offers. */
async function contactCandidate(db: SupabaseClient, job: Job, c: Candidate, row: DemoManagerWorkOrderRow) {
  if (["responding", "queued", "claimed", "submitting", "submitted", "sent", "deferred", "delivered", "unknown", "declined", "expired", "failed", "blocked", "canceled"].includes(c.status)) return;
  const { data: enrolled, error } = await db.rpc("enroll_vendor_sourcing_candidate", { p_candidate_id: c.id, p_lease_token: job.lease_token }); check(error);
  const localId = String(enrolled.local_directory_id);
  const emailFallback = async () => {
    const result = await dispatchVendorQuoteEmail(db, { candidateId: c.id, leaseToken: job.lease_token });
    if (!result.ok) await candidateUpdate(db, job, c.id, {
      status: result.state === "unknown" ? "email_delivery_unknown" : result.state,
      reason: result.state === "manual_contact_required" ? "Share the quote response link through an appropriate channel. Automated email requires current invitation evidence and a verified workspace sender." : result.reason,
    });
  };
  const phone = normalizeE164(c.contact.phone);
  if (!phone) return emailFallback();
  const { data: directory, error: directoryError } = await db.from("manager_vendor_records").select("vendor_user_id,row_data").eq("id", localId).eq("manager_user_id", job.manager_user_id).single(); check(directoryError);
  if (!directory) return candidateUpdate(db, job, c.id, { status: "permission_required", reason: "Vendor directory unavailable. Verify contact permission." });
  const vendorUserId = directory.vendor_user_id as string | null;
  if (normalizeE164(directory.row_data?.phone) !== phone) return candidateUpdate(db, job, c.id, { status: "permission_required", reason: "Vendor phone changed. Verify contact permission." });
  const { data: binding, error: bindingError } = await db.from("vendor_coordination_phone_bindings").select("phone_e164,verified_at,revoked_at").eq("manager_user_id", job.manager_user_id).eq("vendor_directory_id", localId).maybeSingle(); check(bindingError);
  const { data: profile, error: profileError } = vendorUserId ? await db.from("profiles").select("phone,phone_verified_at").eq("id", vendorUserId).maybeSingle() : { data: null, error: null }; check(profileError);
  const verified = (binding?.verified_at && !binding.revoked_at && binding.phone_e164 === phone) || (profile?.phone_verified_at && normalizeE164(profile.phone) === phone);
  const conversationKey = buildConversationKey({ ownerManagerUserId: job.manager_user_id, role: "vendor", counterpartyUserId: vendorUserId, counterpartyPhone: phone });
  const sender = await resolveVendorOutreachIdentity(db, job.manager_user_id, job.work_order_id, "sms");
  if (!sender?.workPhone || !sender.messagingServiceSid) return emailFallback();
  const [suppression, consent] = await Promise.all([readSmsSuppressionState(db, phone, { userId: vendorUserId }), readScopedSmsConsentState(db, phone, { managerUserId: job.manager_user_id, purpose: VENDOR_QUOTE_SMS_PURPOSE, sendClass: "automated", conversationKey, messagingServiceSid: sender.messagingServiceSid })]);
  if (!suppression.ok || !consent.ok) throw new Error("SMS permission could not be verified");
  if (suppression.optedOut || consent.state === "revoked") return candidateUpdate(db, job, c.id, { status: "suppressed", reason: "Vendor opted out of SMS" });
  if (verified && consent.state !== "granted") {
    const replyScope = await readScopedSmsConsentState(db, phone, { managerUserId: job.manager_user_id, purpose: "vendor_conversation", sendClass: "transactional", conversationKey, messagingServiceSid: sender.messagingServiceSid });
    if (!replyScope.ok) throw new Error("Reply permission could not be verified");
    if (replyScope.state === "granted") {
      const { data: session, error: sessionError } = await db.from("agent_sessions").select("id").eq("landlord_id", job.manager_user_id).eq("work_order_id", job.work_order_id).eq("vendor_directory_id", localId).eq("vendor_phone_e164", phone).eq("status", "active").maybeSingle(); check(sessionError);
      if (session) return candidateUpdate(db, job, c.id, { status: "responding", reason: "Vendor initiated a verified conversation. Collecting the quote by reply." });
    }
  }
  if (!verified || consent.state !== "granted" || !await quoteConsentMatchesCandidate(db, job, c.id, phone, conversationKey)) return emailFallback();
  const { error: sessionError } = await db.from("agent_sessions").upsert({ landlord_id: job.manager_user_id, user_id: vendorUserId, kind: "vendor_work_order", vendor_user_id: vendorUserId, vendor_directory_id: localId, work_order_id: job.work_order_id, vendor_phone_e164: phone, status: "active", updated_at: new Date().toISOString() }, { onConflict: "work_order_id,vendor_directory_id" }); check(sessionError);
  const publicFacts = await loadPublicVendorServiceFacts(db, { managerUserId: job.manager_user_id, workOrderId: job.work_order_id });
  if (!publicFacts) return candidateUpdate(db, job, c.id, { status: "blocked", reason: "Service facts unavailable" });
  const queued = await enqueueOwnerSms({ managerUserId: job.manager_user_id, actorUserId: job.manager_user_id, recipientPhone: phone, recipientUserId: vendorUserId, propertyId: row.propertyId || row.assignedPropertyId || null, sendClass: "automated", purpose: VENDOR_QUOTE_SMS_PURPOSE, conversationKey, counterpartyRole: "vendor", dedupeKey: `vendor-quote:${job.work_order_id}:${c.dedupe_key}`, body: `Hi ${c.contact.name}, this is ${sender.displayName}'s service assistant. Service ${publicFacts.serviceReference}${publicFacts.city ? ` in ${publicFacts.city}` : ""}: ${publicFacts.problemSummary ?? "Problem not specified"}. Can you help, and what dates are available? Please flag any diagnostic or consultation fee. This is a quote request; no work or payment is approved.` }, db);
  await candidateUpdate(db, job, c.id, queued.ok ? { status: queued.status, outbox_id: queued.outboxId.startsWith("in_app_test:") ? null : queued.outboxId, reason: null } : { status: "blocked", reason: queued.error });
}
async function runJob(db: SupabaseClient, job: Job) {
  const { data: work, error } = await db.from("portal_work_order_records").select("id,manager_user_id,row_data,property_id").eq("id", job.work_order_id).eq("manager_user_id", job.manager_user_id).maybeSingle(); check(error);
  if (!work) return transition(db, job, { state: "complete", reason: "Service unavailable" });
  const row = work.row_data as DemoManagerWorkOrderRow;
  const { data: proposals, error: proposalError } = await db.from("vendor_coordination_proposals").select("*").eq("work_order_id", job.work_order_id); check(proposalError);
  const stopped = sourcingStopReason(row as unknown as Record<string, unknown>, proposals ?? []);
  if (stopped) return transition(db, job, { state: "complete", reason: stopped });
  const settings = await loadVendorDispatchSettings(db, job.manager_user_id);
  if (!settings.quoteSourcingEnabled) return transition(db, job, { state: "paused", reason: "Quote sourcing is turned off" });
  const { data: quoted, error: quoteError } = await db.rpc("vendor_sourcing_has_viable_quote", { p_work_order_id: job.work_order_id, p_manager_user_id: job.manager_user_id }); check(quoteError);
  if (quoted) { await transition(db, job, { state: "quote_collected", reason: "Quote collected. Manager approval is required before any paid visit." }); return; }
  if (isEmergencyWorkOrder(row)) { await transition(db, job, { state: "needs_attention", reason: "Emergency service requires manager attention" }); return; }
  const propertyId = work.property_id || row.propertyId || row.assignedPropertyId;
  const { data: property, error: propertyError } = propertyId ? await db.from("manager_property_records").select("row_data,property_data").eq("id", propertyId).eq("manager_user_id", job.manager_user_id).maybeSingle() : { data: null, error: null }; check(propertyError);
  const facts = property?.row_data?.submission || property?.property_data || property?.row_data || {};
  const location = { city: String(facts.city || "").trim(), zip: String(facts.zip || facts.zipCode || facts.postalCode || "").trim().slice(0, 5) };
  if (!row.category || (!location.city && !location.zip)) return transition(db, job, { state: "needs_attention", reason: "Set the service category and property city or ZIP before sourcing" });
  const all = await candidates(db, job);
  const current = all.filter((c) => c.stage === job.stage);
  if (!current.length) {
    const found = await discover(db, job, row, location);
    const known = new Set(all.flatMap((c) => [c.dedupe_key, ...(normalizeE164(c.contact.phone) ? [`phone:${normalizeE164(c.contact.phone)}`] : [])]));
    const selected = found.filter((c) => { const key = sourcingDedupeKey(c.contact); const phoneKey = normalizeE164(c.contact.phone) ? `phone:${normalizeE164(c.contact.phone)}` : null; if (known.has(key) || (phoneKey && known.has(phoneKey))) return false; known.add(key); if (phoneKey) known.add(phoneKey); return true; }).slice(0, Math.min(3, 9 - all.length));
    const service = await resolveServiceAutomationSettingsForRow(db, createSettingsScopeCache(), job.manager_user_id, propertyId || null);
    const expiresAt = new Date(Date.now() + (service.offerExpiryHours || 48) * 3600000).toISOString();
    if (selected.length) { const { error: insertError } = await db.from("vendor_sourcing_candidates").upsert(selected.map((c) => ({ job_id: job.id, manager_user_id: job.manager_user_id, stage: job.stage, source: sourceNames[job.stage], contact: c.contact, source_directory_id: c.source_directory_id, dedupe_key: sourcingDedupeKey(c.contact), expires_at: expiresAt })), { onConflict: "job_id,dedupe_key", ignoreDuplicates: true }); check(insertError); }
  }
  for (const c of (await candidates(db, job)).filter((c) => c.stage <= job.stage)) {
    if (["declined", "expired", "suppressed", "canceled"].includes(c.status)) continue;
    if (c.outbox_id) {
      const { data: outbox, error: outboxError } = await db.from("sms_outbox").select("status,blocked_reason").eq("id", c.outbox_id).eq("manager_user_id", job.manager_user_id).maybeSingle(); check(outboxError);
      if (outbox) { c.status = outbox.status; await candidateUpdate(db, job, c.id, { status: outbox.status, reason: outbox.blocked_reason }); }
    }
    if (c.expires_at && Date.parse(c.expires_at) <= Date.now()) { await candidateUpdate(db, job, c.id, { status: "expired", reason: "Quote offer expired" }); continue; }
    const offeredId = c.local_directory_id || (c.source === "roster" ? c.source_directory_id : null);
    if (offeredId) { const { data: offer, error: offerError } = await db.from("work_order_vendor_offers").select("status").eq("work_order_id", job.work_order_id).eq("vendor_directory_id", offeredId).maybeSingle(); check(offerError); if (offer?.status === "declined") { await candidateUpdate(db, job, c.id, { status: "declined", reason: "Vendor declined" }); continue; } }
    await contactCandidate(db, job, c, row);
  }
  const active = (await candidates(db, job)).filter((c) => c.stage <= job.stage && ["responding", "queued", "claimed", "submitting", "submitted", "deferred", "sent", "delivered", "unknown", "email_sent", "email_delivered", "email_delivery_unknown"].includes(c.status));
  if (active.length) return transition(db, job, { state: "waiting", reason: "Waiting for vendor replies", next_run_at: new Date(Date.now() + 300000).toISOString() });
  if (job.stage < 2) return transition(db, job, { state: "queued", stage: job.stage + 1, reason: "Trying the next vendor source", next_run_at: new Date().toISOString() });
  await transition(db, job, { state: "needs_attention", reason: "Sources exhausted. Review vendor contact permissions or choose a vendor." });

}
/** Cron recovery owns durable jobs; after() is only a latency optimization. */
export async function sweepVendorSourcing(db: SupabaseClient, workOrderId?: string): Promise<number> {
  const { data, error } = await db.rpc("claim_vendor_sourcing", { p_limit: 3, p_work_order_id: workOrderId ?? null }); check(error);
  for (const job of (data ?? []) as Job[]) {
    try { await runJob(db, job); }
    catch { await transition(db, job, { state: job.attempts >= 5 ? "needs_attention" : "queued", reason: job.attempts >= 5 ? "Sourcing unavailable. Review and resume this service." : "Sourcing temporarily unavailable; retry scheduled", next_run_at: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts)).toISOString() }).catch(() => undefined); }
  }
  return (data ?? []).length;
}
/** Used at both enqueue and final provider dispatch, including delayed outbox rows. */
export async function vendorQuoteSmsIsCurrent(db: SupabaseClient, input: { managerUserId: string; recipientPhone: string; recipientUserId?: string | null; conversationKey?: string | null; counterpartyRole?: string | null; dedupeKey?: string | null }) {
  if (!input.dedupeKey?.startsWith("vendor-quote:")) return false;
  const { data: jobs, error } = await db.from("vendor_sourcing_jobs").select("id,work_order_id,state").eq("manager_user_id", input.managerUserId).in("state", ["queued", "sourcing", "waiting"]); check(error);
  for (const job of jobs ?? []) {
    const prefix = `vendor-quote:${job.work_order_id}:`; if (!input.dedupeKey.startsWith(prefix)) continue;
    const { data: c, error: cError } = await db.from("vendor_sourcing_candidates").select("id,status,contact,local_directory_id,source,source_directory_id,expires_at").eq("job_id", job.id).eq("dedupe_key", input.dedupeKey.slice(prefix.length)).maybeSingle(); check(cError);
    if (!c || ["declined", "cancelled", "expired", "opted_out", "withdrawn"].includes(c.status) || normalizeE164(c.contact?.phone) !== normalizeE164(input.recipientPhone) || !c.expires_at || Date.parse(c.expires_at) <= Date.now()) return false;
    const [{ data: work, error: wError }, { data: proposals, error: pError }, settings] = await Promise.all([db.from("portal_work_order_records").select("row_data").eq("id", job.work_order_id).eq("manager_user_id", input.managerUserId).maybeSingle(), db.from("vendor_coordination_proposals").select("*").eq("work_order_id", job.work_order_id), loadVendorDispatchSettings(db, input.managerUserId)]); check(wError); check(pError);
    if (!work || !settings.quoteSourcingEnabled || sourcingStopReason(work.row_data, proposals ?? [])) return false;
    const vendorProposals = (proposals ?? []).filter((p) => p.vendor_directory_id === c.local_directory_id);
    if (vendorProposals.length && !vendorProposals.some((p) => ["collecting", "ready", "approved"].includes(p.status))) return false;
    const { data: hasQuote, error: quoteError } = await db.rpc("vendor_sourcing_has_viable_quote", { p_work_order_id: job.work_order_id, p_manager_user_id: input.managerUserId }); check(quoteError);
    if (hasQuote) return false;
    if (!await quoteConsentMatchesCandidate(db, { manager_user_id: input.managerUserId, work_order_id: job.work_order_id }, c.id, normalizeE164(input.recipientPhone)!, input.conversationKey || "")) return false;
    const { data: local, error: lError } = await db.from("manager_vendor_records").select("vendor_user_id,row_data").eq("id", c.local_directory_id).eq("manager_user_id", input.managerUserId).maybeSingle(); check(lError);
    if (!local || local.row_data?.active === false || normalizeE164(local.row_data?.phone) !== normalizeE164(input.recipientPhone)) return false;
    const phone = normalizeE164(input.recipientPhone);
    const vendorUserId = local.vendor_user_id || null;
    if ((input.recipientUserId || null) !== vendorUserId || input.counterpartyRole !== "vendor" ||
      input.conversationKey !== buildConversationKey({ ownerManagerUserId: input.managerUserId, role: "vendor", counterpartyUserId: vendorUserId, counterpartyPhone: phone })) return false;
    const [{ data: binding, error: bindingError }, { data: profile, error: profileError }] = await Promise.all([
      db.from("vendor_coordination_phone_bindings").select("phone_e164,verified_at,revoked_at").eq("manager_user_id", input.managerUserId).eq("vendor_directory_id", c.local_directory_id).maybeSingle(),
      vendorUserId ? db.from("profiles").select("phone,phone_verified_at").eq("id", vendorUserId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]); check(bindingError); check(profileError);
    if (!((binding?.verified_at && !binding.revoked_at && normalizeE164(binding.phone_e164) === phone) ||
      (profile?.phone_verified_at && normalizeE164(profile.phone) === phone))) return false;
    const { data: offer, error: offerError } = await db.from("work_order_vendor_offers").select("status,expires_at").eq("work_order_id", job.work_order_id).eq("vendor_directory_id", c.local_directory_id).eq("manager_user_id", input.managerUserId).maybeSingle(); check(offerError);
    if (!offer || offer.status !== "sent" || !offer.expires_at || Date.parse(offer.expires_at) <= Date.now()) return false;
    if (c.source === "shared") { const { data: shared, error: sError } = await db.from("manager_vendor_records").select("row_data").eq("id", c.source_directory_id).maybeSingle(); check(sError); if (!shared || shared.row_data?.sharedWithManagers !== true || shared.row_data?.active === false || normalizeE164(shared.row_data?.phone) !== normalizeE164(input.recipientPhone)) return false; }
    return true;
  }
  return false;
}

/** Pause/takeover fences the same job-bound AI reply path, not unrelated vendor chats. */
export async function sourcingConversationCanReply(db: SupabaseClient, managerUserId: string, workOrderId: string, sms?: { phone: string; conversationKey: string; directoryId: string }) {
  const { data: job, error } = await db.from("vendor_sourcing_jobs").select("id,state").eq("work_order_id", workOrderId).eq("manager_user_id", managerUserId).maybeSingle(); check(error);
  if (!job || job.state === "dormant") return true;
  if (job.state === "paused" || job.state === "complete" || !(await loadVendorDispatchSettings(db, managerUserId)).quoteSourcingEnabled) return false;
  if (sms) {
    const { data: candidate, error: candidateError } = await db.from("vendor_sourcing_candidates").select("id,proposal_id,expires_at")
      .eq("manager_user_id", managerUserId).eq("local_directory_id", sms.directoryId)
      .eq("job_id", job.id).maybeSingle();
    check(candidateError);
    if (!candidate || !(Date.parse(candidate.expires_at) > Date.now()) ||
      !await quoteConsentMatchesCandidate(db, { manager_user_id: managerUserId, work_order_id: workOrderId }, candidate.id, sms.phone, sms.conversationKey)) return false;
    const { data: offer, error: offerError } = await db.from("work_order_vendor_offers").select("status,expires_at")
      .eq("manager_user_id", managerUserId).eq("work_order_id", workOrderId).eq("vendor_directory_id", sms.directoryId).maybeSingle();
    check(offerError);
    if (!offer || offer.status !== "sent" || !(Date.parse(offer.expires_at) > Date.now())) return false;
    const { data: proposal, error: proposalError } = await db.from("vendor_coordination_proposals").select("status,manager_takeover,accepted_bid_id")
      .eq("id", candidate.proposal_id).eq("manager_user_id", managerUserId).eq("work_order_id", workOrderId).maybeSingle();
    check(proposalError);
    if (!proposal || proposal.manager_takeover || proposal.accepted_bid_id || ["approved", "declined", "cancelled"].includes(proposal.status)) return false;
  }
  const [{ data: work, error: workError }, { data: proposals, error: proposalError }] = await Promise.all([
    db.from("portal_work_order_records").select("row_data").eq("id", workOrderId).eq("manager_user_id", managerUserId).maybeSingle(),
    db.from("vendor_coordination_proposals").select("manager_takeover,status,accepted_bid_id").eq("work_order_id", workOrderId),
  ]); check(workError); check(proposalError);
  return Boolean(work && !sourcingStopReason(work.row_data, proposals ?? []));
}
