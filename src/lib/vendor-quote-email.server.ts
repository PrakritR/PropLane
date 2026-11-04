import "server-only";
import { loadPublicVendorServiceFacts } from "@/lib/vendor-quote-public-facts.server";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createVendorQuoteEmailCapabilities, vendorQuoteSenderKey } from "@/lib/vendor-quote-contact.server";
import { resolveVendorOutreachIdentity, vendorQuoteSenderMatches } from "@/lib/vendor-outreach-identity.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import type { VendorQuoteEmailDispatchResult, VendorQuoteSenderIdentity } from "@/lib/vendor-quote-contract";

type Evidence = {
  email?: string; source?: string; sourceUrl?: string; invitationText?: string;
  recordedAt?: string; scope?: string; version?: number; followUpAllowed?: boolean;
};
type Candidate = {
  id: string; job_id: string; manager_user_id: string; source: string; contact: Record<string, unknown>;
  local_directory_id: string | null; proposal_id: string | null; expires_at: string | null;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Evidence is narrowly scoped to an explicit purchasing invitation at the vendor's own site. */
export function isEligibleVendorQuoteEmailEvidence(emailValue: unknown, value: unknown, now = Date.now()): value is Evidence {
  if (typeof emailValue !== "string" || !EMAIL.test(emailValue.trim())) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Evidence;
  if (evidence.source !== "published_quote_invitation" || evidence.scope !== "service_quote" || evidence.version !== 1 || evidence.followUpAllowed !== false ||
      typeof evidence.sourceUrl !== "string" || typeof evidence.invitationText !== "string" || typeof evidence.recordedAt !== "string" ||
      typeof evidence.email !== "string" || evidence.email.trim().toLowerCase() !== emailValue.trim().toLowerCase()) return false;
  let host = "";
  try {
    const url = new URL(evidence.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    host = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return false; }
  const domain = emailValue.trim().toLowerCase().split("@")[1] ?? "";
  if (host !== domain && !host.endsWith(`.${domain}`)) return false;
  const age = now - Date.parse(evidence.recordedAt);
  if (!Number.isFinite(age) || age < -5 * 60_000 || age > 30 * 24 * 60 * 60_000) return false;
  const sentence = evidence.invitationText.trim();
  if (!sentence || sentence.length > 600 || !sentence.toLowerCase().includes(emailValue.trim().toLowerCase())) return false;
  return /\b(?:email|send|submit)\b.{0,90}\b(?:quote|estimate|service request|service inquir)/i.test(sentence);
}

/** Read-only provider readiness check. It never creates or changes a Resend domain. */
export async function isResendSenderDomainReady(email: string, apiKey = process.env.RESEND_API_KEY?.trim() ?? ""): Promise<boolean> {
  if (!apiKey || !EMAIL.test(email)) return false;
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json() as { data?: Array<{ name?: unknown; status?: unknown }> };
    return Array.isArray(body.data) && body.data.some((row) =>
      typeof row.name === "string" && row.name.trim().toLowerCase() === domain && String(row.status).toLowerCase() === "verified");
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

function textPayload(input: { reference: string; category: string; city: string; problemSummary: string | null; responseUrl: string; stopUrl: string; sender: VendorQuoteSenderIdentity }) {
  const service = [input.category, input.city].filter(Boolean).join(" in ") || "a service request";
  return {
    from: `${input.sender.displayName.replace(/[\r\n<>]/g, "").slice(0, 80)} <${input.sender.email}>`,
    to: [""],
    subject: `Quote request ${input.reference}`,
    text: `Hello,\n\nCould you provide a quote for ${service} (reference ${input.reference})? This is a request for pricing only; no service or payment is authorized.${input.problemSummary ? `\n\nReported problem: ${input.problemSummary}` : "\n\nReported problem: Not specified."}\n\nRespond securely: ${input.responseUrl}\n\nTo stop email about this request, use: ${input.stopUrl}\n\n${input.sender.legalName}\n${input.sender.email}`,
    reply_to: "",
  };
}

type ProviderBoundaryInput = {
  outboxId: string; deliveryLeaseToken: string; capabilityId: string; managerUserId: string; workOrderId: string;
  sender: VendorQuoteSenderIdentity; apiKey: string; idempotencyKey: string;
  payload: { from: string; to: string[]; subject: string; text: string; reply_to: string };
  effectSummary: string; metadata: Record<string, string | number | boolean | null>;
};
type ProviderBoundaryDeps = {
  resolveIdentity: typeof resolveVendorOutreachIdentity;
  domainReady: typeof isResendSenderDomainReady;
  send: typeof postResendEmail;
};

/** Testable final provider boundary; authorization and identity are rechecked at handoff. */
export async function sendAuthorizedVendorQuoteEmail(
  db: SupabaseClient,
  input: ProviderBoundaryInput,
  deps: ProviderBoundaryDeps = { resolveIdentity: resolveVendorOutreachIdentity, domainReady: isResendSenderDomainReady, send: postResendEmail },
): Promise<VendorQuoteEmailDispatchResult> {
  const finish = async (state: "accepted" | "failed_before_send" | "unknown", id: string | null, errorCode: string | null) => {
    const { error } = await db.rpc("finish_vendor_quote_email_outbox", {
      p_outbox_id: input.outboxId, p_delivery_lease_token: input.deliveryLeaseToken,
      p_state: state, p_provider_message_id: id, p_error_code: errorCode,
    });
    return !error;
  };
  const currentSender = await deps.resolveIdentity(db, input.managerUserId, input.workOrderId);
  if (!vendorQuoteSenderMatches(currentSender, input.sender) ||
      !input.apiKey || !(await deps.domainReady(input.sender.email, input.apiKey))) {
    await finish("failed_before_send", null, "sender_domain_not_ready");
    return { ok: false, state: "manual_contact_required", reason: "verified_workspace_sender_required" };
  }
  const authorize = async () => db.rpc("authorize_vendor_quote_email_outbox", {
    p_outbox_id: input.outboxId, p_delivery_lease_token: input.deliveryLeaseToken,
  });
  const { data: allowed, error: authError } = await authorize();
  if (authError || allowed !== true) {
    await finish("failed_before_send", null, "final_authorization_expired");
    return { ok: false, state: "failed_before_send", reason: "final_authorization_expired" };
  }
  try {
    const response = await deps.send({ actorUserId: input.managerUserId, apiKey: input.apiKey, payload: input.payload,
      effectSummary: input.effectSummary, metadata: input.metadata, idempotencyKey: input.idempotencyKey });
    const json = await response.json().catch(() => ({})) as { id?: unknown };
    if (response.ok && typeof json.id === "string" && json.id.trim() && json.id.length <= 200 && !/[\r\n\u0000-\u001f]/.test(json.id)) {
      const captured = response.headers.get("X-PropLane-Sms-Test-Captured") === "1" || response.headers.get("X-PropLane-Test-Workspace-Captured") === "1";
      if (!(await finish("accepted", json.id, captured ? "test_captured" : null))) return { ok: false, state: "unknown", reason: "delivery_finalization_unknown" };
      return { ok: true, state: captured ? "captured" : "accepted", providerMessageId: json.id, capabilityId: input.capabilityId };
    }
    const uncertain = response.ok || response.status >= 500;
    if (!(await finish(uncertain ? "unknown" : "failed_before_send", null, `resend_${response.status}`))) return { ok: false, state: "unknown", reason: "delivery_finalization_unknown" };
    return { ok: false, state: uncertain ? "unknown" : "failed_before_send", reason: `resend_${response.status}` };
  } catch {
    await finish("unknown", null, "provider_network_error");
    return { ok: false, state: "unknown", reason: "provider_network_error" };
  }
}

/** One fenced, quote-only initial email. No reminders and no booking authority. */
export async function dispatchVendorQuoteEmail(
  db: SupabaseClient,
  input: { candidateId: string; leaseToken: string },
): Promise<VendorQuoteEmailDispatchResult> {
  const { data: candidate, error: candidateError } = await db.from("vendor_sourcing_candidates").select("*").eq("id", input.candidateId).maybeSingle();
  if (candidateError || !candidate) return { ok: false, state: "failed_before_send", reason: "candidate_unavailable" };
  const c = candidate as Candidate;
  const contactEmail = String(c.contact?.email ?? "").trim().toLowerCase();
  if (c.source !== "web" || !isEligibleVendorQuoteEmailEvidence(contactEmail, c.contact?.emailEvidence)) {
    return { ok: false, state: "manual_contact_required", reason: "explicit_invitation_evidence_required" };
  }
  if (!c.local_directory_id || !c.proposal_id) return { ok: false, state: "manual_contact_required", reason: "vendor_enrollment_required" };
  const { data: job, error: jobError } = await db.from("vendor_sourcing_jobs").select("id,manager_user_id,work_order_id,state,lease_token,lease_until").eq("id", c.job_id).maybeSingle();
  if (jobError || !job) return { ok: false, state: "failed_before_send", reason: "sourcing_job_unavailable" };
  const { data: actualService, error: actualServiceError } = await db.from("portal_work_order_records").select("id,manager_user_id,property_id,row_data").eq("id", job.work_order_id).eq("manager_user_id", c.manager_user_id).maybeSingle();
  if (actualServiceError || !actualService || actualService.manager_user_id !== c.manager_user_id ||
      job.lease_token !== input.leaseToken || Date.parse(String(job.lease_until)) <= Date.now()) return { ok: false, state: "failed_before_send", reason: "sourcing_lease_unavailable" };
  if (actualService.row_data?.bucket !== "open" || actualService.row_data?.vendorId || actualService.row_data?.selfAssigned) return { ok: false, state: "failed_before_send", reason: "service_no_longer_open" };
  const sender = await resolveVendorOutreachIdentity(db, c.manager_user_id, job.work_order_id);
  if (!sender) return { ok: false, state: "manual_contact_required", reason: "workspace_sender_unavailable" };
  const evidence = c.contact.emailEvidence as Evidence;
  const evidenceRecordedAt = Date.parse(String(evidence.recordedAt));
  const evidenceAgeDays = Math.floor((Date.now() - evidenceRecordedAt) / 86_400_000);
  const permissionEvidence = {
    source: evidence.source, sourceUrl: evidence.sourceUrl, invitationText: evidence.invitationText,
    recordedAt: evidence.recordedAt, scope: "service_quote", followUpAllowed: false,
  };
  const permissionEventId = `vendor-quote-invitation:${c.id}:v${evidence.version}:${vendorQuoteSenderKey(sender).slice(0, 12)}`;
  const { error: permissionError } = await db.from("vendor_quote_email_permissions").upsert({
    normalized_email: contactEmail, sender_key: vendorQuoteSenderKey(sender), manager_user_id: c.manager_user_id,
    evidence_kind: "published_quote_invitation", evidence: permissionEvidence, allowed_follow_up: false, active: true,
    event_id: permissionEventId,
  }, { onConflict: "event_id" });
  if (permissionError) return { ok: false, state: "failed_before_send", reason: "permission_evidence_unavailable" };

  const capabilities = await createVendorQuoteEmailCapabilities(db, {
    managerUserId: c.manager_user_id, workOrderId: job.work_order_id, candidateId: c.id,
    directoryId: c.local_directory_id, proposalId: c.proposal_id, recipientEmail: contactEmail,
  }).catch(() => null);
  if (!capabilities) return { ok: false, state: "manual_contact_required", reason: "quote_capability_unavailable" };
  const facts = await loadPublicVendorServiceFacts(db, { managerUserId: c.manager_user_id, workOrderId: job.work_order_id });
  if (!facts) return { ok: false, state: "failed_before_send", reason: "service_facts_unavailable" };
  const payload = textPayload({ reference: facts.serviceReference, category: facts.category, city: facts.city,
    problemSummary: facts.problemSummary, responseUrl: capabilities.responseUrl, stopUrl: capabilities.stopUrl, sender });
  payload.to = [contactEmail];
  payload.reply_to = capabilities.replyTo;
  const payloadHash = sha256(JSON.stringify(payload));
  const idempotencyKey = `vendor-quote-${sha256(`${c.id}:initial:${sender.version}:${evidence.version}:${payloadHash}`)}`;
  const { data: outbox, error: claimError } = await db.rpc("claim_vendor_quote_email_outbox", {
    p_candidate_id: c.id, p_job_lease_token: input.leaseToken, p_capability_id: capabilities.capabilityIds.response,
    p_recipient_email: contactEmail, p_sender_key: vendorQuoteSenderKey(sender), p_sender_version: sender.version,
    p_evidence_version: Number(evidence.version), p_payload_hash: payloadHash, p_idempotency_key: idempotencyKey,
  });
  if (claimError || !outbox) return { ok: false, state: "failed_before_send", reason: "delivery_claim_unavailable" };
  const claimed = (Array.isArray(outbox) ? outbox[0] : outbox) as Record<string, unknown>;
  if (claimed.status === "accepted" || claimed.status === "delivered") return { ok: true, state: "accepted", providerMessageId: String(claimed.provider_message_id ?? "already_accepted"), capabilityId: capabilities.capabilityIds.response };
  if (claimed.status === "unknown") return { ok: false, state: "unknown", reason: "provider_acceptance_unknown" };
  if (claimed.status !== "submitting" || !claimed.lease_token) return { ok: false, state: claimed.status === "suppressed" ? "suppressed" : "failed_before_send", reason: String(claimed.status ?? "delivery_not_claimed") };

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const result = await sendAuthorizedVendorQuoteEmail(db, {
    outboxId: String(claimed.id), deliveryLeaseToken: String(claimed.lease_token), capabilityId: capabilities.capabilityIds.response, managerUserId: c.manager_user_id,
    workOrderId: job.work_order_id, sender, apiKey: apiKey ?? "", idempotencyKey, payload,
    effectSummary: `Vendor quote invitation for service ${facts.serviceReference}`,
    metadata: { candidateId: c.id, evidenceAgeDays, senderMode: sender.mode },
  });
  return result;
}
