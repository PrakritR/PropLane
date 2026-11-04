import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
const boundary = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => boundary.db }));
vi.mock("@/lib/vendor-quote-notification.server", () => ({ notifyVendorQuoteResponse: vi.fn() }));
const identity = vi.hoisted(() => ({ mailbox: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-quote-public-facts.server", () => ({ loadPublicVendorServiceFacts: async () => ({ serviceReference: "SR-1", category: "Service quote", city: "", problemSummary: null }) }));
vi.mock("@/lib/vendor-quote-email-policy.server", () => ({ canSendVendorQuoteEmail: async () => true }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: { id: "m" }, effectiveRole: "manager" }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/vendor-sourcing.server", () => ({ sweepVendorSourcing: vi.fn() }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveWorkspaceWorkEmail: async () => identity.mailbox ? ({ address: "work@example.test", workspaceId: "ws" }) : null }));
vi.mock("@/lib/sms/workspace-send-readiness.server", () => ({
  resolveWorkspaceSenderTransport: async (input: { db: { from: (table: string) => { select: (columns: string) => { eq: (key: string, value: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> } } } } }) => {
    const { data: line } = await input.db.from("manager_sms_numbers").select("*").eq("manager_user_id", "m").maybeSingle();
    return line?.phone_number === "+12065550100" ? { canSend: true, numberRow: line, workspaceId: "ws", messagingServiceSid: "MG1" } : { canSend: false, reason: "number_not_sendable" };
  },
  evaluateWorkspaceSendReadiness: async () => ({ canSend: true, numberRow: { phone_number: "+12065550100" }, messagingServiceSid: "MG1" }),
}));
vi.mock("@/lib/vendor-quote-agent.server", () => ({ runVendorQuoteQuestionTurn: vi.fn(async () => null) }));
import { exchangeVendorQuoteCapability, loadVendorQuoteSession, loadVendorQuoteInboundReplyCapability, assertVendorQuoteSessionBinding, processVendorQuoteSmsChallenge, processVendorQuoteEmailDeliveryEvent, submitVendorQuoteResponse } from "@/lib/vendor-quote-contact.server";
import { runVendorQuoteQuestionTurn } from "@/lib/vendor-quote-agent.server";
import { resolveVendorOutreachIdentity, vendorQuoteSenderKey } from "@/lib/vendor-outreach-identity.server";
import { formatVendorQuoteSmsChallengeMessage } from "@/lib/vendor-quote-contract";
import { POST as sourcingRoute } from "@/app/api/portal/vendor-sourcing/route";
import { POST as responseRoute } from "@/app/api/public/vendor-quote/response/route";
import { POST as challengeRoute } from "@/app/api/public/vendor-quote/sms-challenge/route";
const future = "2099-10-20T00:00:00Z";
const token = "a".repeat(52);
const sender = { mode: "software", managerUserId: "m", displayName: "Manager", legalName: "Manager", email: "work@example.test", workPhone: "+12065550100", messagingServiceSid: "MG1", workspaceId: "ws", version: 1, transportKind: "workspace_number", selectedLineId: null, providerMessagingServiceSid: "MG1" };
function database() {
  const cap = { id: "cap-A", purpose: "response", manager_user_id: "m", job_id: "job", candidate_id: "candidate", work_order_id: "service", vendor_directory_id: "vendor", proposal_id: "proposal", recipient_email: "vendor@example.test", sender_mode: "software", sender_version: 1, sender_snapshot: sender, expires_at: future, token_digest: createHash("sha256").update(token).digest("hex") };
  const tables: Record<string, Record<string, unknown>[]> = {
    vendor_quote_contact_capabilities: [cap], vendor_outreach_workspace_profiles: [], profiles: [{ id: "m", full_name: "Manager" }],
    portal_work_order_records: [{ id: "service", manager_user_id: "m", property_id: "p", row_data: { bucket: "open", reference: "SR-1" } }],
    manager_property_records: [{ id: "p", manager_user_id: "m", workspace_id: "ws" }],
    manager_sms_numbers: [{ manager_user_id: "m", workspace_id: "ws", phone_number: sender.workPhone, messaging_service_sid: "MG1", provision_state: "active" }],
    vendor_sourcing_jobs: [{ id: "job", state: "waiting", manager_user_id: "m", work_order_id: "service" }],
    vendor_sourcing_candidates: [{ id: "candidate", manager_user_id: "m", job_id: "job", local_directory_id: "vendor", proposal_id: "proposal", contact: { email: "vendor@example.test" }, expires_at: future }],
    work_order_vendor_offers: [{ work_order_id: "service", manager_user_id: "m", vendor_directory_id: "vendor", status: "sent", expires_at: future }],
    vendor_coordination_proposals: [{ id: "proposal", manager_user_id: "m", work_order_id: "service", vendor_directory_id: "vendor", status: "collecting", version: 1 }],
    vendor_quote_contact_sessions: [], vendor_quote_responses: [], vendor_quote_email_permissions: [], vendor_quote_sms_consent_events: [], vendor_quote_sms_consent_challenges: [],
  };
  const rpc = vi.fn<(name: string, args?: unknown) => Promise<{ data: boolean; error: null }>>(async () => ({ data: true, error: null }));
  const db = { rpc: (name: string, args?: unknown) => name === "read_vendor_quote_sender_authority_revision"
    ? Promise.resolve({ data: [{ revision: "1", evaluated_at: new Date().toISOString() }], error: null }) : rpc(name, args), from(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    q.select = () => q; q.order = () => q; q.limit = () => q;
    q.eq = (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return q; };
    q.is = (key: string, value: unknown) => { rows = rows.filter(r => (r[key] ?? null) === value); return q; };
    q.in = () => q; q.gt = () => q;
    q.insert = (row: Record<string, unknown>) => { const inserted = { id: "new-cap", ...row }; (tables[table] ??= []).push(inserted); rows = [inserted]; return q; };
    q.single = async () => ({ data: rows[0] ?? null, error: null });
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (resolve: (r: unknown) => unknown) => resolve({ data: rows, error: null });
    return q;
  } };
  return { db: db as never, tables, cap, rpc };
}
beforeEach(() => { identity.mailbox = true; vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "private-test-key"); });
describe("composed real quote contact and sender", () => {
  it("resolves a current SMS line without an email mailbox and rejects a wrong work line", async () => {
    const { db, tables } = database(); identity.mailbox = false;
    expect(await resolveVendorOutreachIdentity(db, "m", "service")).toBeNull();
    expect(await resolveVendorOutreachIdentity(db, "m", "service", "sms")).toMatchObject({ email: "", workPhone: "+12065550100" });
    tables.manager_sms_numbers[0].phone_number = "+12065550999";
    expect(await resolveVendorOutreachIdentity(db, "m", "service", "sms")).toMatchObject({ workPhone: null });
  });

  it("exchanges, reloads and verifies native reply against the actual current sender", async () => {
    const { db, cap } = database();
    expect(vendorQuoteSenderKey(sender as never)).toHaveLength(64);
    const result = await exchangeVendorQuoteCapability(db, { token });
    expect(result.projection).toMatchObject({ reference: "SR-1", sessionBinding: "cap-A" });
    expect(await loadVendorQuoteSession(db, result.sessionToken)).toMatchObject({ currentVersion: 1 });
    cap.purpose = "inbound_reply";
    expect(await loadVendorQuoteInboundReplyCapability(db, { token, fromEmail: "vendor@example.test" })).toMatchObject({ capabilityId: "cap-A" });
    expect(await loadVendorQuoteInboundReplyCapability(db, { token, fromEmail: "wrong@example.test" })).toBeNull();
  });
  it("projects only canonical proposal terms including zero, clears and windows", async () => {
    const { db, tables } = database();
    Object.assign(tables.vendor_coordination_proposals[0], { duration_minutes: 30, vendor_windows: [{ startIso: "2099-10-19T12:00:00Z", endIso: "2099-10-19T14:00:00Z", timeZone: "America/Los_Angeles" }] });
    const { sessionToken, projection: initial } = await exchangeVendorQuoteCapability(db, { token });
    expect(initial).toMatchObject({ quote: { durationMinutes: 30, laborCents: null, windows: initial.windows } });
    tables.vendor_quote_responses.push({ candidate_id: "candidate", response: { laborCents: 10000, scope: "old", windows: [], followUpReply: "Answer" } });
    const window = { startIso: "2099-10-19T12:00:00Z", endIso: "2099-10-19T14:00:00Z", timeZone: "America/Los_Angeles" };
    Object.assign(tables.vendor_coordination_proposals[0], { version: 3, labor_cents: 25000, materials_cents: 0, consultation_fee_cents: null, scope: "", exclusions: "No paint", duration_minutes: 60, vendor_windows: [window] });
    expect(await loadVendorQuoteSession(db, sessionToken)).toMatchObject({ currentVersion: 3, followUpReply: "Answer", quote: { laborCents: 25000, materialsCents: 0, diagnosticFeeCents: null, scope: "", exclusions: "No paint", durationMinutes: 60, windows: [window] }, windows: [window] });
    Object.assign(tables.vendor_coordination_proposals[0], { labor_cents: null, materials_cents: null, exclusions: "", duration_minutes: null, vendor_windows: [] });
    expect(await loadVendorQuoteSession(db, sessionToken)).toMatchObject({ quote: null, windows: [] });
    Object.assign(tables.vendor_coordination_proposals[0], { exclusions: "No paint" });
    expect(await loadVendorQuoteSession(db, sessionToken)).toMatchObject({ quote: { exclusions: "No paint", laborCents: null }, windows: [] });
  });
  it("issues a manual link through the real route and helper using persisted enrollment", async () => {
    const { db, tables } = database(); boundary.db = db;
    const request = (candidateId: string) => new Request("https://example.test/api/portal/vendor-sourcing", { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body: JSON.stringify({ action: "response_link", workOrderId: "service", candidateId, directoryId: "forged", proposalId: "forged" }) });
    const result = await sourcingRoute(request("candidate"));
    expect(result.status).toBe(200);
    const link = await result.json();
    expect(link).toMatchObject({ url: expect.stringContaining("/vendor-quote#"), capabilityId: "new-cap" });
    expect((await exchangeVendorQuoteCapability(db, { token: new URL(link.url).hash.slice(1) })).projection).toMatchObject({ sessionBinding: "new-cap" });
    expect(tables.vendor_quote_contact_capabilities.at(-1)).toMatchObject({ vendor_directory_id: "vendor", proposal_id: "proposal", recipient_email: "vendor@example.test" });
    expect((await sourcingRoute(request("foreign"))).status).toBe(409);
    tables.vendor_sourcing_candidates[0].contact = { email: "" };
    expect((await sourcingRoute(request("candidate"))).status).toBe(409);
  });
  it("returns a refresh conflict for a stale atomic submission", async () => {
    const { db, rpc } = database(); boundary.db = db;
    const { sessionToken } = await exchangeVendorQuoteCapability(db, { token });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "stale coordination version" } } as never);
    const response = await responseRoute(new Request("https://example.test/api/public/vendor-quote/response", { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json", "X-Vendor-Quote-Binding": "cap-A", Cookie: `vendor_quote_response_session=${sessionToken}` }, body: JSON.stringify({ action: "submit", expectedVersion: 1, response: { laborCents: null, materialsCents: null, diagnosticFeeCents: null, scope: "", exclusions: "", durationMinutes: null, windows: [], question: "" } }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Refresh") });
  });
  it("rejects another tab's binding even at the same quote version", async () => {
    const { db, tables, cap } = database();
    const a = await exchangeVendorQuoteCapability(db, { token });
    const b = { ...cap, id: "cap-B", token_digest: createHash("sha256").update("b".repeat(52)).digest("hex") };
    tables.vendor_quote_contact_capabilities.push(b);
    const second = await exchangeVendorQuoteCapability(db, { token: "b".repeat(52) });
    await expect(assertVendorQuoteSessionBinding(db, second.sessionToken, a.projection.sessionBinding!)).rejects.toThrow("unavailable");
    await expect(assertVendorQuoteSessionBinding(db, second.sessionToken, second.projection.sessionBinding!)).resolves.toBeUndefined();
    boundary.db = db;
    const request = (path: string, body: unknown) => new Request(`https://example.test/api/public/vendor-quote/${path}`, { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json", "X-Vendor-Quote-Binding": "cap-A", Cookie: `vendor_quote_response_session=${second.sessionToken}` }, body: JSON.stringify(body) });
    expect((await responseRoute(request("response", { action: "submit", expectedVersion: 1, response: {} }))).status).toBe(404);
    expect((await responseRoute(request("response", { action: "decline", expectedVersion: 1 }))).status).toBe(404);
    expect((await challengeRoute(request("sms-challenge", { phoneE164: "+12065550101", consented: true }))).status).toBe(404);

  });
  it("feeds the displayed full message into the actual inbound parser and scoped grant RPC", async () => {
    const { db, tables, rpc } = database();
    tables.vendor_quote_sms_consent_challenges.push({ id: "challenge", capability_id: "cap-A", manager_user_id: "m", requested_phone: "+12065550101", work_phone: "+12065550100", messaging_service_sid: "MG1", code_digest: createHmac("sha256", "private-test-key").update("cap-A:+12065550101:123456789012").digest("hex") });
    const result = await processVendorQuoteSmsChallenge(db, { fromPhone: "+12065550101", toPhone: "+12065550100", body: formatVendorQuoteSmsChallengeMessage("123456789012"), messageSid: "SM1" });
    expect(result).toEqual({ handled: true, granted: true });
    expect(rpc).toHaveBeenCalledWith("consume_vendor_quote_sms_challenge", expect.objectContaining({ p_challenge_id: "challenge", p_inbound_event_id: "SM1" }));
  });
  it.each(["name", "mailbox", "workspace", "line", "mode"])("rejects pending challenge when current %s changes", async (change) => {
    const { db, tables, rpc } = database();
    tables.vendor_quote_sms_consent_challenges.push({ id: "challenge", capability_id: "cap-A", manager_user_id: "m", requested_phone: "+12065550101", work_phone: "+12065550100", messaging_service_sid: "MG1", code_digest: createHmac("sha256", "private-test-key").update("cap-A:+12065550101:123456789012").digest("hex") });
    if (change === "name") tables.profiles[0].full_name = "Other manager";
    if (change === "mailbox") identity.mailbox = false;
    if (change === "workspace") tables.manager_property_records[0].workspace_id = "other";
    if (change === "line") tables.manager_sms_numbers[0].phone_number = "+12065550999";
    if (change === "mode") tables.vendor_outreach_workspace_profiles.push({ manager_user_id: "m", mode: "managed", version: 2 });
    expect(await processVendorQuoteSmsChallenge(db, { fromPhone: "+12065550101", toPhone: "+12065550100", body: "QUOTE 123456789012", messageSid: "SM1" })).toEqual({ handled: true, granted: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("keeps the collected quote page and native replies open until an actual closing boundary", async () => {
    const { db, tables, cap } = database();
    tables.vendor_sourcing_jobs[0].state = "quote_collected";
    const { sessionToken } = await exchangeVendorQuoteCapability(db, { token });
    expect(await loadVendorQuoteSession(db, sessionToken)).toMatchObject({ currentVersion: 1 });
    await expect(submitVendorQuoteResponse(db, sessionToken, { expectedVersion: 1, response: { laborCents: 100, materialsCents: 0, diagnosticFeeCents: 0, scope: "Repair", exclusions: "", durationMinutes: 30, windows: [], question: "Which day?" } })).resolves.toBeDefined();
    cap.purpose = "inbound_reply";
    expect(await loadVendorQuoteInboundReplyCapability(db, { token, fromEmail: "vendor@example.test" })).toMatchObject({ workOrderId: "service" });
    tables.vendor_coordination_proposals[0].status = "approved";
    expect(await loadVendorQuoteInboundReplyCapability(db, { token, fromEmail: "vendor@example.test" })).toBeNull();
  });
  it("asks for an explicitly confirmed diagnostic fee on an otherwise exact repair", async () => {
    const { db } = database();
    const { sessionToken } = await exchangeVendorQuoteCapability(db, { token });
    await submitVendorQuoteResponse(db, sessionToken, { expectedVersion: 1, response: { laborCents: 15000, materialsCents: 0, diagnosticFeeCents: null, scope: "Repair pipe", exclusions: "", durationMinutes: 60, windows: [{ startIso: "2099-10-19T12:00:00Z", endIso: "2099-10-19T14:00:00Z", timeZone: "America/Los_Angeles" }], question: "" } });
    expect(runVendorQuoteQuestionTurn).toHaveBeenCalledWith(db, expect.objectContaining({ text: expect.stringContaining("an exact diagnostic fee (enter 0 if none)") }));
  });
  it("propagates failed atomic callbacks for retry and replays the same event", async () => {
    const { db, rpc } = database();
    rpc.mockResolvedValueOnce({ data: false, error: { message: "transient" } } as never);
    const input = { eventId: "evt", providerMessageId: "mail", kind: "bounced" as const, occurredAt: "2026-10-18T12:00:00Z" };
    await expect(processVendorQuoteEmailDeliveryEvent(db, input)).rejects.toThrow("could not be applied");
    expect(await processVendorQuoteEmailDeliveryEvent(db, input)).toEqual({ handled: true });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
});
