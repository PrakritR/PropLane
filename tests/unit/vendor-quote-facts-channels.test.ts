import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ payload: null as unknown, tool: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveWorkspaceWorkEmail: async () => ({ address: "work@example.test", workspaceId: "ws" }) }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: async () => "+12065550100" }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: async (input: { payload: unknown }) => { boundary.payload = input.payload; return new Response(JSON.stringify({ id: "mail" }), { status: 200 }); } }));
vi.mock("@/lib/agent/runtime-model", () => ({ smsTaskModel: () => ({ model: "test", tier: "standard", provider: "anthropic", route: "anthropic" }) }));
vi.mock("@/lib/agent/model", () => ({ hasAgentModelCredential: () => true }));
vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: async ({ registry, ctx }: { registry: Map<string, { handler: (ctx: unknown, input: unknown) => Promise<unknown> }>; ctx: unknown }) => { expect([...registry.keys()]).toEqual(["get_current_quote_request"]); boundary.tool = await registry.get("get_current_quote_request")!.handler(ctx, {}); return { reply: "Answer", toolTrace: [] }; } }));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentTurn: async (_options: unknown, _history: unknown, run: (observer: unknown) => Promise<unknown>) => run({}) }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({ reserveCommsCredit: async () => ({ allowed: true, duplicate: false }), finishCommsCredit: async () => {} }));
vi.mock("@/lib/comms-billing/turn-result.server", () => ({ commsTurnKey: async () => "key", completeCommsTurn: async () => {}, readCommsTurnResult: async () => null }));
import { dispatchVendorQuoteEmail } from "@/lib/vendor-quote-email.server";
import { runVendorQuoteQuestionTurn } from "@/lib/vendor-quote-agent.server";

const future = "2099-10-20T00:00:00Z";
const sender = { mode: "software", managerUserId: "m", displayName: "Manager", legalName: "Manager", email: "work@example.test", workPhone: "+12065550100", messagingServiceSid: "MG1", workspaceId: "ws", version: 1 };
const canaries = ["Jane Secret", "private@example.test", "555-555-0199", "123 Secret Street", "unit 9", "door code 4321", "private notes", "https://private.test/photo", "sibling service"];
function database(description: string) {
  const tables: Record<string, Record<string, unknown>[]> = {
    profiles: [{ id: "m", full_name: "Manager" }], vendor_outreach_workspace_profiles: [],
    portal_work_order_records: [{ id: "service", manager_user_id: "m", property_id: "p", row_data: { bucket: "open", category: "Plumbing", reference: "WO-2048", title: "Plumbing issue", description, privateNotes: canaries.join(" | ") } }],
    manager_property_records: [{ id: "p", manager_user_id: "m", workspace_id: "ws", row_data: { submission: { city: "Seattle", address: canaries[3], unit: canaries[4] } } }],
    manager_sms_numbers: [{ manager_user_id: "m", workspace_id: "ws", phone_number: sender.workPhone, messaging_service_sid: "MG1", provision_state: "active" }],
    vendor_sourcing_jobs: [{ id: "job", state: "waiting", manager_user_id: "m", work_order_id: "service", lease_token: "lease", lease_until: future }],
    vendor_sourcing_candidates: [{ id: "candidate", source: "web", manager_user_id: "m", job_id: "job", local_directory_id: "vendor", proposal_id: "proposal", contact: { email: "vendor@example.test", emailEvidence: { email: "vendor@example.test", source: "published_quote_invitation", sourceUrl: "https://example.test/quotes", invitationText: "Email vendor@example.test to request a quote", recordedAt: new Date().toISOString(), scope: "service_quote", version: 1, followUpAllowed: false } }, expires_at: future }],
    work_order_vendor_offers: [{ work_order_id: "service", manager_user_id: "m", vendor_directory_id: "vendor", status: "sent", expires_at: future }],
    vendor_coordination_proposals: [{ id: "proposal", manager_user_id: "m", work_order_id: "service", vendor_directory_id: "vendor", status: "collecting", version: 1 }],
    vendor_quote_contact_capabilities: [], vendor_quote_responses: [], vendor_quote_email_permissions: [], vendor_quote_sms_consent_events: [], vendor_quote_sms_consent_challenges: [],
    manager_vendor_records: [{ id: "vendor", manager_user_id: "m" }], agent_sessions: [{ id: "session", landlord_id: "m", work_order_id: "service", vendor_directory_id: "vendor" }], agent_messages: [],
  };
  let seq = 0;
  const db = { rpc: async (name: string) => ({ error: null, data: name === "claim_vendor_quote_email_outbox" ? { id: "outbox", status: "submitting", lease_token: "delivery" } : true }), from(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    q.select = () => q; q.order = () => q; q.limit = () => q;
    q.eq = (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return q; };
    q.is = (key: string, value: unknown) => { rows = rows.filter(r => (r[key] ?? null) === value); return q; };
    q.in = (key: string, values: unknown[]) => { rows = rows.filter(r => values.includes(r[key])); return q; };
    q.gt = () => q;
    q.insert = (row: Record<string, unknown>) => { const added = { id: `insert-${++seq}`, ...row }; (tables[table] ??= []).push(added); rows = [added]; return q; };
    q.upsert = (row: Record<string, unknown>) => { (tables[table] ??= []).push(row); rows = [row]; return q; };
    q.single = async () => ({ data: rows[0] ?? null, error: null });
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (resolve: (result: unknown) => unknown) => resolve({ data: rows, error: null });
    return q;
  } };
  return { db: db as never, tables };
}

beforeEach(() => {
  boundary.payload = null; boundary.tool = null;
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("RESEND_API_KEY", "test-key"); vi.stubEnv("RESEND_REPLY_DOMAIN", "example.test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ name: "example.test", status: "verified" }] }), { status: 200 })));
});

describe("public quote facts across actual channels", () => {
  it.each([
    ["Leaking pipe", "A pipe is leaking."], ["Clogged drain", "A drain is clogged."], ["The pipe is not leaking", null],
  ])("keeps %s consistent in the dispatched email and agent tool", async (description, expected) => {
    const { db, tables } = database(description);
    const sent = await dispatchVendorQuoteEmail(db, { candidateId: "candidate", leaseToken: "lease" });
    expect(sent).toMatchObject({ ok: true });
    const payload = boundary.payload as { text: string };
    expect(payload.text).toContain(`Reported problem: ${expected ?? "Not specified."}`);
    const cap = tables.vendor_quote_contact_capabilities.find(row => row.purpose === "response")!;
    expect(cap).toBeTruthy();
    const answer = await runVendorQuoteQuestionTurn(db, { capabilityId: String(cap.id), sourceMessageId: "message", text: "What is the problem?", projection: {} as never, managerUserId: "m" });
    expect(answer).toBe("Answer");
    expect(boundary.tool).toMatchObject({ reference: "SR-2048", category: "Plumbing", city: "Seattle", problemDescription: expected });
    for (const canary of canaries) { expect(JSON.stringify(payload)).not.toContain(canary); expect(JSON.stringify(boundary.tool)).not.toContain(canary); }
  });
});
