import "server-only";
import { resolveVendorQuoteSenderProof } from "@/lib/vendor-quote-sender-proof.server";
import { evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";
import { loadPublicVendorServiceFacts } from "@/lib/vendor-quote-public-facts.server";
import { canSendVendorQuoteEmail } from "@/lib/vendor-quote-email-policy.server";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { runVendorQuoteQuestionTurn } from "@/lib/vendor-quote-agent.server";
import type {
  VendorQuoteExistingResponse,
  VendorQuotePublicProjection,
  VendorQuoteResponseInput,
  VendorQuoteSenderIdentity,
} from "@/lib/vendor-quote-contract";
import { resolveVendorOutreachIdentity, vendorQuoteSenderKey, vendorQuoteSenderMatches } from "@/lib/vendor-outreach-identity.server";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[a-z2-7]{52}$/;
const MAX_SESSION_MS = 30 * 60_000;

export class VendorQuoteConflictError extends Error {
  constructor() { super("This quote changed. Refresh the page and review your response before trying again."); this.name = "VendorQuoteConflictError"; }
}

export class VendorQuoteUnavailableError extends Error {
  constructor() { super("Quote link unavailable."); this.name = "VendorQuoteUnavailableError"; }
}

type CapabilityIssueInput = {
  managerUserId: string;
  workOrderId: string;
  candidateId: string;
  directoryId: string;
  proposalId: string;
  recipientEmail: string;
  senderIdentity: VendorQuoteSenderIdentity;
  expiresAt: string;
  purpose?: "response" | "withdrawal" | "inbound_reply";
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function encodeBase32(bytes: Buffer): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function newSessionToken(): string { return encodeBase32(randomBytes(32)); }
function deriveCapabilityToken(nonce: string, purpose: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("Quote capability service unavailable.");
  return encodeBase32(createHmac("sha256", key).update(`vendor-quote-capability:v1:${purpose}:${nonce}`).digest());
}

function sameSender(current: VendorQuoteSenderIdentity | null, cap: Record<string, unknown>): boolean {
  const snapshot = cap.sender_snapshot as VendorQuoteSenderIdentity | null;
  return Boolean(current && current.mode === cap.sender_mode && current.version === cap.sender_version &&
    vendorQuoteSenderMatches(current, snapshot));
}

async function ensureActiveQuote(db: SupabaseClient, cap: Record<string, unknown>): Promise<boolean> {
  const [job, candidate, offer, proposal, work] = await Promise.all([
    db.from("vendor_sourcing_jobs").select("state,manager_user_id,work_order_id").eq("id", cap.job_id).maybeSingle(),
    db.from("vendor_sourcing_candidates").select("manager_user_id,local_directory_id,proposal_id,expires_at").eq("id", cap.candidate_id).maybeSingle(),
    db.from("work_order_vendor_offers").select("status,expires_at").eq("work_order_id", cap.work_order_id).eq("manager_user_id", cap.manager_user_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle(),
    db.from("vendor_coordination_proposals").select("status,manager_takeover,accepted_bid_id").eq("id", cap.proposal_id).maybeSingle(),
    db.from("portal_work_order_records").select("manager_user_id,row_data").eq("id", cap.work_order_id).maybeSingle(),
  ]);
  return Boolean(!job.error && !candidate.error && !offer.error && !proposal.error && !work.error && job.data && ["queued", "sourcing", "waiting", "needs_attention", "quote_collected"].includes(job.data.state) &&
    job.data.manager_user_id === cap.manager_user_id && job.data.work_order_id === cap.work_order_id &&
    candidate.data && candidate.data.manager_user_id === cap.manager_user_id && candidate.data.local_directory_id === cap.vendor_directory_id &&
    candidate.data.proposal_id === cap.proposal_id && Date.parse(String(candidate.data.expires_at)) > Date.now() &&
    offer.data?.status === "sent" && Date.parse(String(offer.data.expires_at)) > Date.now() &&
    proposal.data && !proposal.data.manager_takeover && !proposal.data.accepted_bid_id && !["approved", "declined", "cancelled"].includes(proposal.data.status) &&
    work.data && work.data.manager_user_id === cap.manager_user_id && work.data.row_data?.bucket === "open" &&
    !work.data.row_data?.vendorId && !work.data.row_data?.selfAssigned);
}

/** Issue a one-use 256-bit bearer token. Only its digest is persisted. */
export async function issueVendorQuoteCapability(
  db: SupabaseClient,
  input: CapabilityIssueInput,
): Promise<{ capabilityId: string; token: string; expiresAt: string }> {
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  const expiresAt = Date.parse(input.expiresAt);
  if (!EMAIL.test(recipientEmail) || input.senderIdentity.managerUserId !== input.managerUserId ||
      input.senderIdentity.mode !== "software" && input.senderIdentity.mode !== "managed" ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Quote capability cannot be issued.");
  const [job, candidate, offer, proposal, currentIdentity] = await Promise.all([
    db.from("vendor_sourcing_jobs").select("id,manager_user_id,work_order_id,state").eq("work_order_id", input.workOrderId).maybeSingle(),
    db.from("vendor_sourcing_candidates").select("id,job_id,manager_user_id,local_directory_id,proposal_id,expires_at,status").eq("id", input.candidateId).maybeSingle(),
    db.from("work_order_vendor_offers").select("status,expires_at").eq("work_order_id", input.workOrderId).eq("manager_user_id", input.managerUserId).eq("vendor_directory_id", input.directoryId).maybeSingle(),
    db.from("vendor_coordination_proposals").select("id,manager_user_id,work_order_id,vendor_directory_id,status,version").eq("id", input.proposalId).maybeSingle(),
    resolveVendorOutreachIdentity(db, input.managerUserId, input.workOrderId),
  ]);
  if (job.error || candidate.error || offer.error || proposal.error || !currentIdentity ||
      !vendorQuoteSenderMatches(currentIdentity, input.senderIdentity) || !job.data || !candidate.data || !offer.data || !proposal.data ||
      job.data.manager_user_id !== input.managerUserId || job.data.work_order_id !== input.workOrderId ||
      !["queued", "sourcing", "waiting", "needs_attention", "quote_collected"].includes(job.data.state) ||
      candidate.data.job_id !== job.data.id || candidate.data.manager_user_id !== input.managerUserId ||
      candidate.data.local_directory_id !== input.directoryId || candidate.data.proposal_id !== input.proposalId ||
      !candidate.data.expires_at || Date.parse(candidate.data.expires_at) <= Date.now() ||
      offer.data.status !== "sent" || !offer.data.expires_at || Date.parse(offer.data.expires_at) <= Date.now() ||
      proposal.data.manager_user_id !== input.managerUserId || proposal.data.work_order_id !== input.workOrderId ||
      proposal.data.vendor_directory_id !== input.directoryId || ["approved", "declined", "cancelled"].includes(proposal.data.status) ||
      Date.parse(input.expiresAt) > Math.min(Date.parse(candidate.data.expires_at), Date.parse(offer.data.expires_at))) {
    throw new Error("Quote capability cannot be issued.");
  }
  if (!await ensureActiveQuote(db, {
    job_id: job.data.id, candidate_id: input.candidateId, manager_user_id: input.managerUserId,
    work_order_id: input.workOrderId, vendor_directory_id: input.directoryId, proposal_id: input.proposalId,
  })) throw new Error("Quote capability cannot be issued.");
  const purpose = input.purpose ?? "response";
  const tokenNonce = randomBytes(32).toString("hex");
  const token = deriveCapabilityToken(tokenNonce, purpose);
  const { data, error } = await db.from("vendor_quote_contact_capabilities").insert({
    token_digest: sha256(token), token_nonce: tokenNonce, purpose, manager_user_id: input.managerUserId,
    job_id: job.data.id, candidate_id: input.candidateId, work_order_id: input.workOrderId,
    vendor_directory_id: input.directoryId, proposal_id: input.proposalId, recipient_email: recipientEmail,
    sender_mode: currentIdentity.mode, sender_version: currentIdentity.version, sender_snapshot: currentIdentity,
    expires_at: new Date(Math.min(expiresAt, Date.parse(candidate.data.expires_at), Date.parse(offer.data.expires_at))).toISOString(),
  }).select("id,expires_at").single();
  if (error || !data) throw new Error("Quote capability cannot be saved.");
  return { capabilityId: String(data.id), token, expiresAt: String(data.expires_at) };
}

export async function createVendorQuoteResponseLink(
  db: SupabaseClient,
  input: Pick<CapabilityIssueInput, "managerUserId" | "workOrderId" | "candidateId">,
): Promise<{ url: string; capabilityId: string; expiresAt: string }> {
  const sender = await resolveVendorOutreachIdentity(db, input.managerUserId, input.workOrderId);
  if (!sender) throw new Error("Sender identity unavailable.");
  const { data: candidate, error: candidateError } = await db.from("vendor_sourcing_candidates").select("job_id,local_directory_id,proposal_id,contact,expires_at").eq("id", input.candidateId).eq("manager_user_id", input.managerUserId).maybeSingle();
  if (candidateError || !candidate?.local_directory_id || !candidate?.proposal_id || !EMAIL.test(String(candidate.contact?.email ?? "").trim())) throw new Error("Vendor needs an enrolled quote offer and valid email address.");
  const { data: job, error: jobError } = await db.from("vendor_sourcing_jobs").select("id").eq("id", candidate.job_id).eq("work_order_id", input.workOrderId).eq("manager_user_id", input.managerUserId).maybeSingle();
  if (jobError || !job) throw new Error("Quote response link unavailable.");
  const { data: offer, error: offerError } = await db.from("work_order_vendor_offers").select("expires_at").eq("work_order_id", input.workOrderId).eq("manager_user_id", input.managerUserId).eq("vendor_directory_id", candidate.local_directory_id).maybeSingle();
  if (offerError) throw new Error("Quote response link unavailable.");
  const expiry = Math.min(Date.parse(String(candidate?.expires_at ?? "")), Date.parse(String(offer?.expires_at ?? "")));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Quote response link unavailable.");
  const capability = await issueVendorQuoteCapability(db, { ...input, directoryId: candidate.local_directory_id, proposalId: candidate.proposal_id, recipientEmail: String(candidate.contact.email), senderIdentity: sender, expiresAt: new Date(expiry).toISOString() });
  return { url: `${resolveEmailLinkBaseUrl()}/vendor-quote#${capability.token}`, capabilityId: capability.capabilityId, expiresAt: capability.expiresAt };
}

export async function buildVendorQuoteInboundReplyAddress(
  db: SupabaseClient,
  input: CapabilityIssueInput,
): Promise<{ address: string; capabilityId: string; expiresAt: string }> {
  if (!await canSendVendorQuoteEmail(db, input.recipientEmail)) throw new Error("Vendor quote email is unavailable.");
  const domain = process.env.RESEND_REPLY_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("Vendor quote email replies are unavailable.");
  const capability = await issueVendorQuoteCapability(db, { ...input, purpose: "inbound_reply" });
  return { address: `vq+${capability.token}@${domain}`, capabilityId: capability.capabilityId, expiresAt: capability.expiresAt };
}

export async function createVendorQuoteEmailCapabilities(
  db: SupabaseClient,
  input: Omit<CapabilityIssueInput, "senderIdentity" | "expiresAt" | "purpose">,
): Promise<{ responseUrl: string; stopUrl: string; replyTo: string; capabilityIds: { response: string; withdrawal: string; inboundReply: string }; expiresAt: string }> {
  const sender = await resolveVendorOutreachIdentity(db, input.managerUserId, input.workOrderId);
  if (!sender) throw new Error("Sender identity unavailable.");
  const [{ data: candidate }, { data: offer }] = await Promise.all([
    db.from("vendor_sourcing_candidates").select("expires_at").eq("id", input.candidateId).eq("manager_user_id", input.managerUserId).maybeSingle(),
    db.from("work_order_vendor_offers").select("expires_at").eq("work_order_id", input.workOrderId).eq("manager_user_id", input.managerUserId).eq("vendor_directory_id", input.directoryId).maybeSingle(),
  ]);
  const expiry = Math.min(Date.parse(String(candidate?.expires_at ?? "")), Date.parse(String(offer?.expires_at ?? "")));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Quote response link unavailable.");
  const expiresAt = new Date(expiry).toISOString();
  const [response, withdrawal, reply] = await Promise.all([
    reuseOrIssueCapability(db, { ...input, senderIdentity: sender, expiresAt, purpose: "response" }),
    reuseOrIssueCapability(db, { ...input, senderIdentity: sender, expiresAt, purpose: "withdrawal" }),
    reuseOrIssueCapability(db, { ...input, senderIdentity: sender, expiresAt, purpose: "inbound_reply" }),
  ]);
  const origin = resolveEmailLinkBaseUrl();
  const replyDomain = process.env.RESEND_REPLY_DOMAIN?.trim().toLowerCase();
  if (!replyDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(replyDomain)) throw new Error("Vendor quote email replies are unavailable.");
  return {
    responseUrl: `${origin}/vendor-quote#${response.token}`,
    stopUrl: `${origin}/vendor-quote#stop=${withdrawal.token}`,
    replyTo: `vq+${reply.token}@${replyDomain}`,
    capabilityIds: { response: response.capabilityId, withdrawal: withdrawal.capabilityId, inboundReply: reply.capabilityId },
    expiresAt: response.expiresAt,
  };
}

async function reuseOrIssueCapability(
  db: SupabaseClient,
  input: CapabilityIssueInput,
): Promise<{ capabilityId: string; token: string; expiresAt: string }> {
  const email = input.recipientEmail.trim().toLowerCase();
  const { data, error } = await db.from("vendor_quote_contact_capabilities").select("id,token_nonce,expires_at,sender_snapshot")
    .eq("purpose", input.purpose ?? "response").eq("manager_user_id", input.managerUserId).eq("candidate_id", input.candidateId)
    .eq("recipient_email", email).eq("sender_version", input.senderIdentity.version).is("revoked_at", null).is("consumed_at", null)
    .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("Quote capability state unavailable.");
  if (data && vendorQuoteSenderMatches(input.senderIdentity, data.sender_snapshot as VendorQuoteSenderIdentity)) {
    return { capabilityId: String(data.id), token: deriveCapabilityToken(String(data.token_nonce), input.purpose ?? "response"), expiresAt: String(data.expires_at) };
  }
  return issueVendorQuoteCapability(db, input);
}

export async function loadVendorQuoteInboundReplyCapability(
  db: SupabaseClient,
  input: { token: string; fromEmail: string },
): Promise<{ capabilityId: string; managerUserId: string; workOrderId: string; candidateId: string; directoryId: string; proposalId: string; recipientEmail: string } | null> {
  const token = input.token.trim().toLowerCase();
  const fromEmail = input.fromEmail.trim().toLowerCase();
  if (!TOKEN.test(token) || !EMAIL.test(fromEmail)) return null;
  const { data: cap, error } = await db.from("vendor_quote_contact_capabilities").select("*")
    .eq("token_digest", sha256(token)).eq("purpose", "inbound_reply").maybeSingle();
  if (error || !cap || cap.revoked_at || cap.consumed_at || Date.parse(cap.expires_at) <= Date.now() || String(cap.recipient_email).toLowerCase() !== fromEmail) return null;
  const [sender, job, candidate, offer, proposal] = await Promise.all([
    resolveVendorOutreachIdentity(db, String(cap.manager_user_id), String(cap.work_order_id)),
    db.from("vendor_sourcing_jobs").select("state,manager_user_id,work_order_id").eq("id", cap.job_id).maybeSingle(),
    db.from("vendor_sourcing_candidates").select("manager_user_id,local_directory_id,proposal_id,expires_at").eq("id", cap.candidate_id).maybeSingle(),
    db.from("work_order_vendor_offers").select("status,expires_at").eq("work_order_id", cap.work_order_id).eq("manager_user_id", cap.manager_user_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle(),
    db.from("vendor_coordination_proposals").select("status,manager_takeover,accepted_bid_id").eq("id", cap.proposal_id).maybeSingle(),
  ]);
  if (!sameSender(sender, cap) || !(await ensureActiveQuote(db, cap)) ||
      !job.data || job.data.manager_user_id !== cap.manager_user_id || job.data.work_order_id !== cap.work_order_id || !["queued", "sourcing", "waiting", "needs_attention", "quote_collected"].includes(job.data.state) ||
      !candidate.data || candidate.data.manager_user_id !== cap.manager_user_id || candidate.data.local_directory_id !== cap.vendor_directory_id || candidate.data.proposal_id !== cap.proposal_id || Date.parse(String(candidate.data.expires_at)) <= Date.now() ||
      offer.data?.status !== "sent" || Date.parse(String(offer.data.expires_at)) <= Date.now() || !proposal.data || proposal.data.manager_takeover || proposal.data.accepted_bid_id || ["approved", "declined", "cancelled"].includes(proposal.data.status)) return null;
  return { capabilityId: String(cap.id), managerUserId: String(cap.manager_user_id), workOrderId: String(cap.work_order_id), candidateId: String(cap.candidate_id), directoryId: String(cap.vendor_directory_id), proposalId: String(cap.proposal_id), recipientEmail: fromEmail };
}

/** Recheck a reply capability immediately before an outbound provider call. */
export async function isVendorQuoteOutboundReplyAuthorized(db: SupabaseClient, input: { capabilityId: string; recipientEmail: string }): Promise<boolean> {
  const { data: cap, error } = await db.from("vendor_quote_contact_capabilities")
    .select("id,purpose,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at,revoked_at,consumed_at")
    .eq("id", input.capabilityId).eq("purpose", "inbound_reply").maybeSingle();
  if (error || !cap || cap.revoked_at || cap.consumed_at || Date.parse(String(cap.expires_at)) <= Date.now() || !Number.isFinite(Date.parse(String(cap.expires_at))) || String(cap.recipient_email).toLowerCase() !== input.recipientEmail.trim().toLowerCase()) return false;
  try {
    const sender = await resolveVendorOutreachIdentity(db, String(cap.manager_user_id), String(cap.work_order_id));
    return sameSender(sender, cap) && await ensureActiveQuote(db, cap);
  } catch { return false; }
}

type ExchangeInput = { token: string; purpose?: "response" | "withdrawal" };
export async function exchangeVendorQuoteCapability(
  db: SupabaseClient,
  input: ExchangeInput,
): Promise<{ sessionToken: string; expiresAt: string; projection: VendorQuotePublicProjection }> {
  const token = input.token.trim();
  if (!TOKEN.test(token)) throw new VendorQuoteUnavailableError();
  const { data: capability, error } = await db.from("vendor_quote_contact_capabilities").select("id,purpose,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at,revoked_at,consumed_at")
    .eq("token_digest", sha256(token)).maybeSingle();
  const purpose = input.purpose ?? "response";
  if (error || !capability || capability.purpose !== purpose || capability.revoked_at || capability.consumed_at || Date.parse(capability.expires_at) <= Date.now()) throw new VendorQuoteUnavailableError();
  const current = await resolveVendorOutreachIdentity(db, String(capability.manager_user_id), String(capability.work_order_id));
  if (purpose === "response" && (!sameSender(current, capability) || !(await ensureActiveQuote(db, capability)))) throw new VendorQuoteUnavailableError();
  const sessionToken = newSessionToken();
  const expiresAt = new Date(Math.min(Date.now() + MAX_SESSION_MS, Date.parse(capability.expires_at))).toISOString();
  const { error: saveError } = await db.from("vendor_quote_contact_sessions").insert({ session_digest: sha256(sessionToken), capability_id: capability.id, expires_at: expiresAt });
  if (saveError) throw new VendorQuoteUnavailableError();
  return { sessionToken, expiresAt, projection: await projectCapability(db, capability) };
}

async function capabilityForSession(db: SupabaseClient, token: string, purpose = "response") {
  if (!TOKEN.test(token)) throw new VendorQuoteUnavailableError();
  const { data: session, error } = await db.from("vendor_quote_contact_sessions").select("id,capability_id,expires_at,revoked_at")
    .eq("session_digest", sha256(token)).maybeSingle();
  if (error || !session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) throw new VendorQuoteUnavailableError();
  const { data: capability, error: capError } = await db.from("vendor_quote_contact_capabilities").select("*").eq("id", session.capability_id).maybeSingle();
  if (capError || !capability || capability.purpose !== purpose || capability.revoked_at || capability.consumed_at || Date.parse(capability.expires_at) <= Date.now()) throw new VendorQuoteUnavailableError();
  if (purpose === "response") {
    const current = await resolveVendorOutreachIdentity(db, String(capability.manager_user_id), String(capability.work_order_id));
    if (!sameSender(current, capability) || !(await ensureActiveQuote(db, capability))) throw new VendorQuoteUnavailableError();
  }
  return capability;
}

async function projectCapability(db: SupabaseClient, cap: Record<string, unknown>): Promise<VendorQuotePublicProjection> {
  const [facts, proposal, response, permission, consent, pendingChallenge] = await Promise.all([
    loadPublicVendorServiceFacts(db, { managerUserId: String(cap.manager_user_id), workOrderId: String(cap.work_order_id) }),
    db.from("vendor_coordination_proposals").select("version,labor_cents,materials_cents,consultation_fee_cents,scope,exclusions,duration_minutes,vendor_windows").eq("id", cap.proposal_id).eq("manager_user_id", cap.manager_user_id).maybeSingle(),
    db.from("vendor_quote_responses").select("response,response_version,request_version").eq("candidate_id", cap.candidate_id).order("request_version", { ascending: false }).limit(1).maybeSingle(),
    db.from("vendor_quote_email_permissions").select("evidence_kind,active,revoked_at").eq("normalized_email", String(cap.recipient_email).toLowerCase()).in("evidence_kind", ["recipient_withdrawal", "hard_bounce", "complaint"]).eq("active", true).limit(1),
    db.from("vendor_quote_sms_consent_events").select("id,revoked_at").eq("capability_id", cap.id).is("revoked_at", null).maybeSingle(),
    db.from("vendor_quote_sms_consent_challenges").select("id").eq("capability_id", cap.id).is("consumed_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle(),
  ]);
  if (!facts || proposal.error || !proposal.data) throw new VendorQuoteUnavailableError();
  const snap = cap.sender_snapshot as VendorQuoteSenderIdentity;
  const stored = response.data?.response as Record<string, unknown> | undefined;
  const q = stored ?? {};
  const p = proposal.data;
  const windows = Array.isArray(p.vendor_windows) ? p.vendor_windows as VendorQuoteExistingResponse["windows"] : [];
  const hasQuote = [p.labor_cents, p.materials_cents, p.consultation_fee_cents, p.scope, p.exclusions, p.duration_minutes]
    .some((v) => v !== undefined && v !== null && v !== "") || windows.length > 0;
  const projectedQuote: VendorQuoteExistingResponse | null = hasQuote ? {
    laborCents: typeof p.labor_cents === "number" ? p.labor_cents : null,
    materialsCents: typeof p.materials_cents === "number" ? p.materials_cents : null,
    diagnosticFeeCents: typeof p.consultation_fee_cents === "number" ? p.consultation_fee_cents : null,
    scope: typeof p.scope === "string" ? p.scope : null,
    exclusions: typeof p.exclusions === "string" ? p.exclusions : null,
    durationMinutes: typeof p.duration_minutes === "number" ? p.duration_minutes : null,
    windows,
  } : null;
  const active = !permission.error && !(permission.data ?? []).length;
  return {
    sessionBinding: String(cap.id),
    reference: facts.serviceReference,
    category: facts.category,
    city: facts.city,
    problemDescription: facts.problemSummary,
    senderName: snap.displayName,
    senderEmail: snap.email,
    expiresAt: String(cap.expires_at),
    currentVersion: Number(proposal.data.version) || 1,
    quote: projectedQuote,
    followUpReply: typeof q.followUpReply === "string" ? q.followUpReply : null,
    windows,
    canStopEmail: active,
    smsConsent: consent.data ? "granted" : pendingChallenge.data ? "pending" : "not_requested",
  };
}

export async function loadVendorQuoteSession(db: SupabaseClient, sessionToken: string, purpose: "response" | "withdrawal" = "response"): Promise<VendorQuotePublicProjection | null> {
  try { const capability = await capabilityForSession(db, sessionToken, purpose); return projectCapability(db, capability); }
  catch { return null; }
}

export async function loadVendorQuoteAgentContext(db: SupabaseClient, capabilityId: string): Promise<{
  projection: VendorQuotePublicProjection;
  managerUserId: string;
  directoryId: string;
  workOrderId: string;
  sessionId: string;
} | null> {
  const { data: cap, error } = await db.from("vendor_quote_contact_capabilities").select("*")
    .eq("id", capabilityId).eq("purpose", "response").maybeSingle();
  if (error || !cap || cap.revoked_at || cap.consumed_at || Date.parse(cap.expires_at) <= Date.now()) return null;
  const current = await resolveVendorOutreachIdentity(db, String(cap.manager_user_id), String(cap.work_order_id));
  if (!sameSender(current, cap) || !(await ensureActiveQuote(db, cap))) return null;
  const [job, candidate, offer, proposal, directory] = await Promise.all([
    db.from("vendor_sourcing_jobs").select("state,manager_user_id,work_order_id").eq("id", cap.job_id).maybeSingle(),
    db.from("vendor_sourcing_candidates").select("manager_user_id,local_directory_id,proposal_id,expires_at").eq("id", cap.candidate_id).maybeSingle(),
    db.from("work_order_vendor_offers").select("status,expires_at").eq("work_order_id", cap.work_order_id).eq("manager_user_id", cap.manager_user_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle(),
    db.from("vendor_coordination_proposals").select("status,manager_takeover,accepted_bid_id").eq("id", cap.proposal_id).maybeSingle(),
    db.from("manager_vendor_records").select("vendor_user_id,row_data").eq("id", cap.vendor_directory_id).eq("manager_user_id", cap.manager_user_id).maybeSingle(),
  ]);
  if (!job.data || !["queued", "sourcing", "waiting", "needs_attention", "quote_collected"].includes(job.data.state) || job.data.manager_user_id !== cap.manager_user_id || job.data.work_order_id !== cap.work_order_id ||
      !candidate.data || candidate.data.manager_user_id !== cap.manager_user_id || candidate.data.local_directory_id !== cap.vendor_directory_id || candidate.data.proposal_id !== cap.proposal_id || Date.parse(String(candidate.data.expires_at)) <= Date.now() ||
      offer.data?.status !== "sent" || Date.parse(String(offer.data.expires_at)) <= Date.now() || !proposal.data || proposal.data.manager_takeover || proposal.data.accepted_bid_id || ["approved", "declined", "cancelled"].includes(proposal.data.status) || !directory.data) return null;
  const { data: existing, error: sessionError } = await db.from("agent_sessions").select("id,landlord_id,work_order_id,vendor_directory_id")
    .eq("work_order_id", cap.work_order_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle();
  if (sessionError) return null;
  let sessionId = String(existing?.id ?? "");
  if (existing && (existing.landlord_id !== cap.manager_user_id || existing.work_order_id !== cap.work_order_id || existing.vendor_directory_id !== cap.vendor_directory_id)) return null;
  if (!sessionId) {
    const vendorUserId = directory.data.vendor_user_id ? String(directory.data.vendor_user_id) : null;
    const { data: created, error: createError } = await db.from("agent_sessions").upsert({
      landlord_id: cap.manager_user_id, user_id: vendorUserId, kind: "vendor_work_order",
      vendor_user_id: vendorUserId, vendor_directory_id: cap.vendor_directory_id, work_order_id: cap.work_order_id,
      status: "active",
    }, { onConflict: "work_order_id,vendor_directory_id", ignoreDuplicates: true }).select("id,landlord_id,work_order_id,vendor_directory_id").maybeSingle();
    if (createError) return null;
    if (created) {
      if (created.landlord_id !== cap.manager_user_id || created.work_order_id !== cap.work_order_id || created.vendor_directory_id !== cap.vendor_directory_id) return null;
      sessionId = String(created.id);
    } else {
      const { data: raced, error: raceError } = await db.from("agent_sessions").select("id,landlord_id,work_order_id,vendor_directory_id")
        .eq("work_order_id", cap.work_order_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle();
      if (raceError || !raced || raced.landlord_id !== cap.manager_user_id) return null;
      sessionId = String(raced.id);
    }
  }
  return {
    projection: await projectCapability(db, cap),
    managerUserId: String(cap.manager_user_id), directoryId: String(cap.vendor_directory_id),
    workOrderId: String(cap.work_order_id), sessionId,
  };
}

export async function submitVendorQuoteResponse(
  db: SupabaseClient,
  sessionToken: string,
  input: { expectedVersion: number; response: VendorQuoteResponseInput },
): Promise<{ projection: VendorQuotePublicProjection; followUpReply: string | null; question: string; sourceMessageId: string; response: VendorQuoteResponseInput }> {
  const cap = await capabilityForSession(db, sessionToken);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new VendorQuoteUnavailableError();
  const value = input.response;
  if (![value.laborCents, value.materialsCents, value.diagnosticFeeCents].every((amount) => amount === null || Number.isInteger(amount) && amount >= 0 && amount <= 1_000_000_000) ||
      (value.durationMinutes !== null && (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 15 || value.durationMinutes > 480)) ||
      value.windows.length > 32 || value.scope.length > 4000 || value.exclusions.length > 4000 || value.question.length > 2000) throw new Error("Quote response is invalid.");
  const sourceMessageId = `vendor-quote:${cap.id}:${input.expectedVersion}:response`;
  const persistedResponse = {
    laborCents: value.laborCents, materialsCents: value.materialsCents, diagnosticFeeCents: value.diagnosticFeeCents,
    scope: value.scope.trim(), exclusions: value.exclusions.trim(), durationMinutes: value.durationMinutes,
    windows: value.windows, question: value.question.trim(),
  };
  const senderProof = await resolveVendorQuoteSenderProof(db, cap, "email");
  if (!senderProof) throw new VendorQuoteUnavailableError();
  const { error: saveError } = await db.rpc("vendor_quote_submit_response", {
    p_sender_proof: senderProof,
    p_session_digest: sha256(sessionToken), p_expected_version: input.expectedVersion, p_response: persistedResponse,
  });
  if (saveError?.code === "40001" || saveError?.code === "55P03") throw new VendorQuoteConflictError();
  if (saveError?.message === "stale coordination version" || saveError?.message === "response version reused with changed input") throw new VendorQuoteConflictError();
  if (saveError) throw new Error("Quote response could not be saved.");
  const missing: string[] = [];
  if (value.laborCents === null && value.diagnosticFeeCents === null) missing.push("an exact labor amount or diagnostic fee");
  if (value.materialsCents === null && value.laborCents !== null) missing.push("an exact materials amount");
  if (value.diagnosticFeeCents === null) missing.push("an exact diagnostic fee (enter 0 if none)");
  if (!value.scope.trim()) missing.push("the work scope and exclusions");
  if (value.durationMinutes === null) missing.push("the expected duration");
  if (!value.windows.length) missing.push("dated availability windows with timezone");
  const followUpPrompt = value.question.trim() || (missing.length ? `The saved response is partial. Ask only for these missing details: ${missing.join(", ")}.` : "");
  let answer: string | null = null;
  if (followUpPrompt) {
    const projection = await projectCapability(db, cap);
    answer = await runVendorQuoteQuestionTurn(db, { capabilityId: String(cap.id), sourceMessageId, text: followUpPrompt, projection, managerUserId: String(cap.manager_user_id) });
    if (answer) {
      const { error } = await db.from("vendor_quote_responses").update({ response: { ...persistedResponse, followUpReply: answer } })
        .eq("candidate_id", cap.candidate_id).eq("request_version", input.expectedVersion).eq("capability_id", cap.id);
      if (error) throw new Error("Response follow-up could not be saved.");
    }
  }
  const projection = await projectCapability(db, cap);
  return { projection, followUpReply: projection.followUpReply ?? null, question: value.question.trim(), sourceMessageId, response: value };
}

export async function declineVendorQuote(db: SupabaseClient, sessionToken: string, input: { expectedVersion: number; reason?: string }) {
  const cap = await capabilityForSession(db, sessionToken);
  const senderProof = await resolveVendorQuoteSenderProof(db, cap, "email");
  if (!senderProof) throw new VendorQuoteUnavailableError();
  const { error } = await db.rpc("vendor_quote_capability_action", { p_sender_proof: senderProof, p_session_digest: sha256(sessionToken), p_action: {
    kind: "decline_vendor", expected_version: input.expectedVersion, reason: input.reason?.slice(0, 1000) ?? "Vendor declined this service quote.",
  } });
  if (error?.code === "40001" || error?.code === "55P03") throw new VendorQuoteConflictError();
  if (error) throw new VendorQuoteUnavailableError();
  await db.from("vendor_quote_contact_capabilities").update({ consumed_at: new Date().toISOString() }).eq("id", cap.id);
  return { ok: true as const };
}

export async function stopVendorQuoteEmail(db: SupabaseClient, sessionToken: string): Promise<{ ok: true }> {
  const cap = await capabilityForSession(db, sessionToken, "withdrawal");
  const snap = cap.sender_snapshot as VendorQuoteSenderIdentity;
  const eventId = `vendor-quote-withdrawal:${cap.id}`;
  const { error } = await db.from("vendor_quote_email_permissions").upsert({
    normalized_email: String(cap.recipient_email).toLowerCase(), sender_key: "*", manager_user_id: cap.manager_user_id,
    evidence_kind: "recipient_withdrawal", evidence: { source: "response_page", capabilityId: cap.id },
    active: true, event_id: eventId, revoked_at: null,
  }, { onConflict: "event_id" });
  if (error) throw new Error("Email preference could not be saved.");
  await db.from("vendor_quote_email_outbox").update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("candidate_id", cap.candidate_id).in("status", ["queued", "submitting"]);
  await db.from("vendor_quote_contact_capabilities").update({ revoked_at: new Date().toISOString() })
    .eq("candidate_id", cap.candidate_id).eq("recipient_email", String(cap.recipient_email).toLowerCase()).eq("purpose", "response").is("revoked_at", null);
  await db.from("vendor_quote_contact_sessions").update({ revoked_at: new Date().toISOString() }).eq("capability_id", cap.id);
  void snap;
  return { ok: true };
}

export async function requestVendorQuoteSmsChallenge(
  db: SupabaseClient,
  sessionToken: string,
  input: { phoneE164: string; consented: true },
): Promise<{ challengeId: string; code: string; destinationPhone: string; expiresAt: string }> {
  const cap = await capabilityForSession(db, sessionToken);
  const phone = input.phoneE164.trim();
  if (input.consented !== true || !/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new Error("Explicit phone consent is required.");
  const proof = await resolveVendorQuoteSenderProof(db, cap, "sms");
  const sender = proof?.senderSnapshot;
  if (sender && proof) {
    const ready = await evaluateWorkspaceSendReadiness({ db, ownerUserId: sender.managerUserId, workspaceId: sender.workspaceId, requiredCents: 1,
      now: new Date(proof.evaluatedAt), policyRead: { db, workspaceId: sender.workspaceId, nowMs: Date.parse(proof.evaluatedAt), validUntilMs: Date.parse(proof.validUntil) } });
    if (!ready.canSend || ready.numberRow.phone_number !== sender.workPhone || ready.messagingServiceSid !== sender.messagingServiceSid ||
        (ready.providerMessagingServiceSid ?? ready.messagingServiceSid) !== sender.providerMessagingServiceSid) throw new VendorQuoteUnavailableError();
  }
  if (!sender?.workPhone || !sender.messagingServiceSid || !sameSender(sender, cap)) throw new VendorQuoteUnavailableError();
  const { data: existing, error: existingError } = await db.from("vendor_coordination_phone_bindings").select("phone_e164,revoked_at")
    .eq("manager_user_id", cap.manager_user_id).eq("vendor_directory_id", cap.vendor_directory_id).maybeSingle();
  if (existingError || existing && !existing.revoked_at && existing.phone_e164 !== phone) throw new Error("Phone identity requires manager review.");
  const [{ data: directory }, { data: proposal }] = await Promise.all([
    db.from("manager_vendor_records").select("vendor_user_id").eq("id", cap.vendor_directory_id).eq("manager_user_id", cap.manager_user_id).maybeSingle(),
    db.from("vendor_coordination_proposals").select("version").eq("id", cap.proposal_id).eq("manager_user_id", cap.manager_user_id).maybeSingle(),
  ]);
  if (!directory) throw new VendorQuoteUnavailableError();
  if (directory.vendor_user_id) {
    const { data: profile } = await db.from("profiles").select("phone,phone_verified_at").eq("id", directory.vendor_user_id).maybeSingle();
    if (profile?.phone_verified_at && profile.phone !== phone) throw new Error("Phone identity requires manager review.");
  }
  const code = randomBytes(8).readBigUInt64BE().toString().padStart(20, "0").slice(0, 12);
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Phone consent is unavailable.");
  const codeDigest = createHmac("sha256", secret).update(`${cap.id}:${phone}:${code}`).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data, error } = await db.from("vendor_quote_sms_consent_challenges").insert({
    capability_id: cap.id, manager_user_id: cap.manager_user_id, candidate_id: cap.candidate_id,
    vendor_directory_id: cap.vendor_directory_id, proposal_id: cap.proposal_id,
    requested_phone: phone, work_phone: sender.workPhone, messaging_service_sid: sender.messagingServiceSid,
    sender_version: sender.version, proposal_version: Number(proposal?.version) || 1, code_digest: codeDigest,
    wording_version: "vendor_quote_sms_v1", expires_at: expiresAt,
  }).select("id,expires_at").single();
  if (error || !data) throw new Error("Phone consent challenge could not be created.");
  return { challengeId: String(data.id), code, destinationPhone: sender.workPhone, expiresAt: String(data.expires_at) };
}

/** Reconcile an already committed atomic grant without re-evaluating current policy. */
export async function reconcileVendorQuoteSmsOutcome(
  db: SupabaseClient,
  input: { fromPhone: string; toPhone: string; messageSid: string; providerMessagingServiceSid?: string | null },
): Promise<"absent" | "committed" | "conflict"> {
  const [receiptRead, challengesRead] = await Promise.all([
    db.from("sms_inbound_receipts").select("message_sid,status,manager_user_id,recipient_phone_key,workspace_id,inbound_payload")
      .eq("message_sid", input.messageSid).maybeSingle(),
    db.from("vendor_quote_sms_consent_challenges").select("capability_id,manager_user_id,requested_phone,work_phone,consumed_at,inbound_event_id")
      .eq("inbound_event_id", input.messageSid).limit(2),
  ]);
  if (receiptRead.error || challengesRead.error) throw new Error("Quote outcome unavailable");
  const receipt = receiptRead.data;
  const challenges = challengesRead.data ?? [];
  if (!receipt && !challenges.length) return "absent";
  if (!receipt || challenges.length !== 1) return "conflict";
  const challenge = challenges[0];
  if (!challenge.consumed_at || challenge.requested_phone !== input.fromPhone || challenge.work_phone !== input.toPhone ||
    challenge.inbound_event_id !== input.messageSid || receipt.status !== "completed" || receipt.manager_user_id !== challenge.manager_user_id) return "conflict";
  const capRead = await db.from("vendor_quote_contact_capabilities").select("manager_user_id,sender_snapshot")
    .eq("id", challenge.capability_id).maybeSingle();
  if (capRead.error) throw new Error("Quote outcome unavailable");
  const cap = capRead.data;
  const workspace = cap?.sender_snapshot?.workspaceId;
  const payload = receipt.inbound_payload;
  let phoneKey = input.fromPhone.replace(/\D/g, "");
  if (phoneKey.length === 11 && phoneKey.startsWith("1")) phoneKey = phoneKey.slice(1);
  return cap && cap.manager_user_id === challenge.manager_user_id && typeof workspace === "string" &&
    cap.sender_snapshot?.workPhone === input.toPhone &&
    (!input.providerMessagingServiceSid || cap.sender_snapshot?.providerMessagingServiceSid === input.providerMessagingServiceSid) &&
    receipt.recipient_phone_key === phoneKey && receipt.workspace_id === workspace &&
    payload?.signedTwilio === true && payload.fromPhone === input.fromPhone && payload.toPhone === input.toPhone &&
    payload.body === "QUOTE [redacted]" && payload.workspaceId === workspace ? "committed" : "conflict";
}

export async function processVendorQuoteSmsChallenge(
  db: SupabaseClient,
  input: { fromPhone: string; toPhone: string; body: string; messageSid: string; providerMessagingServiceSid?: string | null },
): Promise<{ handled: boolean; granted: boolean }> {
  const match = /^QUOTE (\d{12})$/i.exec(input.body.trim());
  if (!match) return { handled: false, granted: false };
  const refused = { handled: true, granted: false };
  if (!/^\+[1-9][0-9]{7,14}$/.test(input.fromPhone) || !/^\+[1-9][0-9]{7,14}$/.test(input.toPhone) || !/^SM[a-zA-Z0-9]+$/.test(input.messageSid)) return refused;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Phone consent processor unavailable.");
  const { data: challenges, error } = await db.from("vendor_quote_sms_consent_challenges")
    .select("id,capability_id,requested_phone,work_phone,messaging_service_sid,code_digest,consumed_at,inbound_event_id")
    .eq("requested_phone", input.fromPhone).eq("work_phone", input.toPhone)
    .is("revoked_at", null).gt("expires_at", new Date().toISOString()).limit(33);
  if (error) throw new Error("Phone consent challenges unavailable.");
  if (!challenges || challenges.length > 32) return refused;
  const matches = challenges.filter((challenge) => {
    const expected = createHmac("sha256", secret).update(`${challenge.capability_id}:${input.fromPhone}:${match[1]}`).digest();
    const stored = /^[a-f0-9]{64}$/i.test(String(challenge.code_digest)) ? Buffer.from(String(challenge.code_digest), "hex") : Buffer.alloc(0);
    return stored.length === expected.length && timingSafeEqual(stored, expected);
  });
  if (matches.length !== 1) return refused;
  const challenge = matches[0];
  if (challenge.consumed_at) return { handled: true, granted: challenge.inbound_event_id === input.messageSid };
  const { data: cap, error: capError } = await db.from("vendor_quote_contact_capabilities").select("*").eq("id", challenge.capability_id).maybeSingle();
  if (capError) throw new Error("Phone consent capability unavailable.");
  if (!cap || cap.revoked_at || cap.consumed_at || Date.parse(cap.expires_at) <= Date.now()) return refused;
  // A stale revision may be retried once, always with a completely fresh canonical evaluation.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const proof = await resolveVendorQuoteSenderProof(db, cap, "sms");
    const sender = proof?.senderSnapshot;
    if (!proof || !sender || sender.workPhone !== input.toPhone || sender.messagingServiceSid !== challenge.messaging_service_sid ||
        input.providerMessagingServiceSid && input.providerMessagingServiceSid !== sender.providerMessagingServiceSid) return refused;
    const { data, error: consumeError } = await db.rpc("consume_vendor_quote_sms_challenge", {
      p_challenge_id: challenge.id, p_code_digest: String(challenge.code_digest), p_from_phone: input.fromPhone,
      p_to_phone: input.toPhone, p_messaging_service_sid: sender.messagingServiceSid, p_inbound_event_id: input.messageSid,
      p_sender_proof: proof,
    });
    if (!consumeError) return { handled: true, granted: data === true };
    if (consumeError.message !== "sender authority changed" || attempt === 1) throw new Error("Phone consent could not be verified.");
  }
  return refused;
}

export async function processVendorQuoteEmailDeliveryEvent(
  db: SupabaseClient,
  input: { eventId: string; providerMessageId: string; kind: "delivered" | "bounced" | "complained"; occurredAt: string },
): Promise<{ handled: boolean }> {
  if (!input.eventId || !input.providerMessageId || !Number.isFinite(Date.parse(input.occurredAt))) return { handled: false };
  const { data, error } = await db.rpc("apply_vendor_quote_email_delivery_event", {
    p_event_id: input.eventId, p_provider_message_id: input.providerMessageId,
    p_event_kind: input.kind, p_occurred_at: input.occurredAt,
  });
  if (error) throw new Error("Email delivery event could not be applied.");
  return { handled: data === true };
}

export { vendorQuoteSenderKey };

/** Nonsecret page identity prevents another tab's cookie replacing this page's target. */
export async function assertVendorQuoteSessionBinding(db: SupabaseClient, token: string, binding: string | null, purpose: "response" | "withdrawal" = "response"): Promise<void> {
  if (!binding) throw new VendorQuoteUnavailableError();
  const cap = await capabilityForSession(db, token, purpose);
  if (String(cap.id) !== binding) throw new VendorQuoteUnavailableError();
}
