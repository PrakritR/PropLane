// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PersistedInboxThread, InboxThreadMessage } from "@/lib/portal-inbox-storage";

const boundary = vi.hoisted(() => ({
  classify: vi.fn(), auditFails: false, planReadable: true, auth: vi.fn(), service: vi.fn(), issueReply: vi.fn(), workEmail: vi.fn(), sendNumber: vi.fn(),
  uiThreads: [] as PersistedInboxThread[], toast: vi.fn(),
  vendorSession: vi.fn(), vendorTurn: vi.fn(), notify: vi.fn(), loadReply: vi.fn(), outboundReply: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()), cookies: vi.fn(async () => new Map([["selected_workspace_id", { value: "workspace-two" }]])) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: boundary.auth }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: boundary.service }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => ({ ok: true })), clientIpFrom: vi.fn(() => "127.0.0.1") }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/resident-relationship", async (original) => ({ ...(await original<typeof import("@/lib/auth/resident-relationship")>()), managerOwnsResident: vi.fn(async () => false) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
  resolveTestWorkspaceClassification: boundary.classify,
  assertTestWorkspacePrincipalCompatibility: vi.fn(async () => undefined),
}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveWorkspaceWorkEmail: boundary.workEmail }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: boundary.sendNumber }));
vi.mock("@/lib/vendor-quote-notification.server", () => ({ notifyVendorQuoteResponse: boundary.notify }));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: vi.fn(() => false) }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ findVendorAgentSessionByThread: boundary.vendorSession, runVendorAgentSessionTurn: boundary.vendorTurn }));
vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
// Billing is a paid-account fixture; recipient, subject, workspace and quote authorization stay real.
vi.mock("@/lib/manager-access-server", async (original) => ({ ...(await original<typeof import("@/lib/manager-access-server")>()), getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: boundary.planReadable, tier: "premium", liveSignupTrial: false })) }));

vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "11111111-1111-4111-8111-111111111111", email: "manager@example.test", ready: true }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => async () => true, useAppUi: () => ({ showToast: boundary.toast }) }));
vi.mock("@/components/portal/payment-schedule-ui", () => ({ useScheduledPaymentMessages: () => ({ messages: [] }) }));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({ ManagerInboxSchedulePanel: () => null }));
vi.mock("@/lib/manager-inbox-contacts", () => ({ buildManagerInboxLiveContacts: () => [], inboxCounterpartyName: (_email: string, fallback: string) => fallback }));
vi.mock("@/lib/demo/demo-session", async (original) => ({ ...(await original<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => true }));
vi.mock("@/lib/portal-inbox-storage", async (original) => ({
  ...(await original<typeof import("@/lib/portal-inbox-storage")>()),
  loadPersistedInbox: () => boundary.uiThreads,
  syncPersistedInboxFromServer: async () => boundary.uiThreads,
  persistInbox: vi.fn(), persistInboxAwait: async () => {},
  upsertPersistedInboxRows: async () => true, invalidatePersistedInboxCache: () => {},
  mergeInboxRowsWithLocalTrash: (rows: unknown[]) => rows, seedDemoInbox: () => {},
  inboxMutationInFlight: () => false, stagePersistedInboxRows: () => {},
}));
import { ManagerInbox } from "@/components/portal/pro-inbox";
import { collapsePersonInboxThreads } from "@/lib/portal-inbox-storage";
afterEach(() => { cleanup(); boundary.uiThreads = []; vi.unstubAllGlobals(); });

import { POST } from "@/app/api/portal/send-inbox-message/route";
import { ingestVendorQuoteInboundEmail } from "@/lib/vendor-quote-inbound-email.server";


const MANAGER = "11111111-1111-4111-8111-111111111111";
const VENDOR_EMAIL = "vendor@example.test";
const services = [
  { workOrderId: "service-one", directoryId: "directory-one", candidateId: "candidate-one", proposalId: "proposal-one", workspaceId: "workspace-one", email: "one@example.test" },
  { workOrderId: "service-two", directoryId: "directory-two", candidateId: "candidate-two", proposalId: "proposal-two", workspaceId: "workspace-two", email: "managed@example.test" },
] as const;
const threadId = (service: typeof services[number]) => `vendor_quote_${service.workOrderId}_${service.directoryId}`;

function fixture(linkedVendor = true) {
  const aliases = new Map<string, string>();
  const revokedCapabilities = new Set<string>();
  let managedMode = false;
  let foreignService = false;
  const issued: Record<string, unknown>[] = [];
  let suppression: string | null = null;
  let policyError = false;
  let personLookupError = false;
  let suppressAfterAppend = false;
  const threads = new Map(services.map((service) => [threadId(service), {
    id: threadId(service), owner_user_id: MANAGER, participant_email: null,
    scope: "axis_portal_inbox_manager_v1", thread_type: "portal_message",
    row_data: { email: VENDOR_EMAIL, folder: "inbox", subject: "Service quote",
      quoteCapabilityId: `cap-${service.workOrderId}`,
      recordRef: { kind: "service", id: service.workOrderId, label: service.workOrderId },
      messages: [{ id: `native-${service.workOrderId}`, from: "Vendor", body: "Which pipe?", channel: "email" }] },
  }]));
  const writes: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    from: vi.fn((table: string) => {
      const filters = new Map<string, unknown>();
      const rows = () => {
        if (table === "vendor_quote_email_permissions") return suppression ? [{ id: "block", evidence_kind: suppression, active: true }] : [];
        if (table === "profiles") return filters.get("id") === MANAGER
          ? [{ id: MANAGER, role: "manager", full_name: "Workspace One" }] : linkedVendor ? [{ id: "vendor-user", role: "vendor", email: VENDOR_EMAIL }] : [];
        if (table === "vendor_outreach_workspace_profiles") return [{ mode: managedMode ? "managed" : "software", version: managedMode ? 2 : 1,
          managed_display_name: "Managed Desk", managed_legal_name: "Managed Legal", managed_email: "managed@example.test",
          managed_work_phone: "+15550000001", managed_messaging_service_sid: "MGmanaged" }];
        if (table === "portal_work_order_records") {
          const service = services.find((item) => item.workOrderId === filters.get("id"));
          return service && (!foreignService || !filters.has("manager_user_id")) ? [{ id: service.workOrderId, manager_user_id: foreignService ? "other-manager" : MANAGER, property_id: `property-${service.workspaceId}`, row_data: { bucket: "open" } }] : [];
        }
        if (table === "manager_property_records") {
          const service = services.find((item) => `property-${item.workspaceId}` === filters.get("id"));
          return service ? [{ manager_user_id: MANAGER, workspace_id: service.workspaceId }] : [];
        }
        if (table === "manager_sms_numbers") return [{ phone_number: "+15550000001", messaging_service_sid: "MGmanaged",
          provision_state: "active", released_at: null, workspace_id: filters.get("workspace_id") }];
        if (table === "profile_roles") return filters.get("role") === "resident" ? [] : [{ role: "manager" }];
        if (table === "manager_vendor_records") return [{ manager_user_id: MANAGER, vendor_user_id: linkedVendor ? "vendor-user" : null, row_data: { email: VENDOR_EMAIL } }];
        if (table === "portal_inbox_thread_aliases") return [...aliases].map(([alias_id, thread_id]) => ({ alias_id, thread_id }))
          .filter((row) => [...filters].every(([key, value]) => row[key as keyof typeof row] === value));
        if (table === "portal_inbox_thread_records") return [...threads.values()].filter((row) =>
          [...filters].every(([key, value]) => key === "row_data->recordRef->>kind" ? row.row_data.recordRef?.kind === value
            : key === "row_data->recordRef->>id" ? row.row_data.recordRef?.id === value
            : row[key as keyof typeof row] === value));
        if (table === "vendor_quote_contact_capabilities") {
          return [...services.map((service) => ({ id: `cap-${service.workOrderId}`, expires_at: "2099-01-01T00:00:00.000Z", revoked_at: revokedCapabilities.has(service.workOrderId) ? "2026-11-01T00:00:00Z" : null, manager_user_id: MANAGER, work_order_id: service.workOrderId, candidate_id: service.candidateId, vendor_directory_id: service.directoryId, proposal_id: service.proposalId, recipient_email: VENDOR_EMAIL })), ...issued]
            .filter((row) => [...filters].every(([key, value]) => row[key as keyof typeof row] === value));
        }
        const service = services.find(item => item.workOrderId === (filters.get("work_order_id") ?? filters.get("id")) || item.candidateId === filters.get("id") || item.proposalId === filters.get("id") || `job-${item.workOrderId}` === filters.get("id")) ?? services[0];
        if (table === "vendor_sourcing_jobs") return [{ id: `job-${service.workOrderId}`, state: "waiting", manager_user_id: MANAGER, work_order_id: service.workOrderId }];
        if (table === "vendor_sourcing_candidates") return [{ id: service.candidateId, job_id: `job-${service.workOrderId}`, manager_user_id: MANAGER, local_directory_id: service.directoryId, proposal_id: service.proposalId, expires_at: "2099-01-01T00:00:00.000Z" }];
        if (table === "work_order_vendor_offers") return [{ status: "sent", expires_at: "2099-01-01T00:00:00.000Z" }];
        if (table === "vendor_coordination_proposals") return [{ id: service.proposalId, manager_user_id: MANAGER, work_order_id: service.workOrderId, vendor_directory_id: service.directoryId, status: "collecting", version: 1 }];
        return [];
      };
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((key: string, value: unknown) => { filters.set(key, value); return query; }),
        in: vi.fn(() => query), ilike: vi.fn(() => query), or: vi.fn(() => query),
        order: vi.fn(() => query), limit: vi.fn(() => query), is: vi.fn(() => query), gt: vi.fn(() => query),
        insert: vi.fn((row: Record<string, unknown>) => {
          if (table === "audit_log") {
            if (boundary.auditFails) return { error: { message: "Audit unavailable" } };
            writes.push({ table, row });
            return { error: null };
          }
          const saved = { ...row, id: `issued-${issued.length}` }; issued.push(saved); writes.push({ table, row: saved }); return { select: () => ({ single: async () => ({ data: saved, error: null }) }) }; }),
        maybeSingle: vi.fn(async () => ({ data: rows()[0] ?? null, error: null })),
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: rows(), error: (table === "vendor_quote_email_permissions" && policyError) || (table === "portal_inbox_thread_records" && !filters.has("id") && personLookupError) ? { message: "unavailable" } : null }).then(resolve),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          writes.push({ table, row });
          if (table === "portal_inbox_thread_records" && suppressAfterAppend) suppression = "recipient_withdrawal";
          if (table === "portal_inbox_thread_records") threads.set(String(row.id), { ...threads.get(String(row.id)), ...row } as never);
          return { error: null };
        }),
        update: vi.fn(() => query),
      };
      return query;
    }),
  };
  boundary.service.mockReturnValue(db);
  return { db, writes, issued, threads, revokeCapability: (workOrderId: string) => { revokedCapabilities.add(workOrderId); },
    foldQuotes: () => {
      addGeneric(threads);
      for (const service of services) { aliases.set(threadId(service), "generic-newer"); threads.delete(threadId(service)); }
    },
    makeServiceForeign: () => { foreignService = true; }, setSuppression: (value: string | null) => { suppression = value; },
    failPersonLookup: () => { personLookupError = true; },
    failPolicy: () => { policyError = true; }, suppressOnAppend: () => { suppressAfterAppend = true; }, setManagedMode: (value: boolean) => { managedMode = value; },
    deleteQuoteMarker: (service: typeof services[number]) => {
      const thread = threads.get(threadId(service));
      if (thread) delete (thread.row_data as { quoteCapabilityId?: string }).quoteCapabilityId;
    } };
}

async function pickSource(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Service", exact: true }));
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
}
function displayRows(threads: ReturnType<typeof fixture>["threads"]): PersistedInboxThread[] {
  return [...threads.values()].map((row, index) => ({
    ...row.row_data, id: row.id, from: "Vendor", email: VENDOR_EMAIL,
    folder: row.row_data.folder as "inbox", subject: row.row_data.subject,
    recordRef: row.row_data.recordRef ? { ...row.row_data.recordRef, kind: "service" as const } : undefined,
    messages: row.row_data.messages as unknown as InboxThreadMessage[],
    body: `History ${row.id}`, preview: "Quote history", unread: false,
    time: row.id === "generic-newer" ? "Nov 3, 11:00 AM" : `Nov 3, 10:${index ? "30" : "00"} AM`,
  }));
}
function addGeneric(threads: ReturnType<typeof fixture>["threads"]) {
  const source = threads.get(threadId(services[0]))!;
  threads.set("generic-newer", { ...source, id: "generic-newer", row_data: {
    ...source.row_data, subject: "Ordinary message", quoteCapabilityId: undefined as never, recordRef: undefined as never, messages: [],
  } });
  return collapsePersonInboxThreads(displayRows(threads), { mergeFolders: true })[0]!;
}

function reply(service: typeof services[number], toEmail = VENDOR_EMAIL, recordRefId: string = service.workOrderId, overrides: Record<string, unknown> = {}) {
  return POST(new Request("http://localhost/api/portal/send-inbox-message", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: threadId(service), senderPortal: "manager", fromName: "Workspace One",
      toEmails: [toEmail], subject: `Re: ${service.workOrderId}`, text: "The copper supply pipe.",
      deliverViaEmail: true, deliverViaSms: false, deliverToPortalInbox: false,
      recordRef: { kind: "service", id: recordRefId, label: recordRefId }, ...overrides }),
  }));
}

describe("manager quote email roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks(); boundary.planReadable = true; boundary.auditFails = false;
    boundary.classify.mockResolvedValue({ kind: "normal" });
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("RESEND_REPLY_DOMAIN", "reply.example.test");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", `whsec_${Buffer.from("test-secret-key").toString("base64")}`);
    boundary.auth.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: MANAGER, email: "manager@example.test" } } })) } });
    boundary.workEmail.mockImplementation(async (_db, _owner, workspaceId) => {
      const service = services.find((item) => item.workspaceId === (workspaceId ?? "workspace-two"));
      return service ? { address: service.email, workspaceId: service.workspaceId } : null;
    });
    boundary.sendNumber.mockResolvedValue("+15550000001");
    boundary.notify.mockResolvedValue(undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "private-test-key");
  });

  it("captures the authenticated manager despite body actor and workspace spoofing", async () => {
    const { writes, threads } = fixture();
    boundary.classify.mockResolvedValue({ kind: "classified", workspaceId: "durable-workspace", role: "manager", state: "active" });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, {
      senderUserId: "forged-actor", managerUserId: "forged-manager", workspaceId: "forged-workspace",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: true, deliveryState: "sent" });
    expect(boundary.classify).toHaveBeenCalledWith(MANAGER, expect.anything());
    expect(writes).toContainEqual({ table: "audit_log", row: expect.objectContaining({
      landlord_id: MANAGER, actor_user_id: MANAGER, action: "test_workspace_effect_captured",
      test_workspace_id: "durable-workspace", input_summary: { kind: "email" },
    }) });
    expect(writes).toContainEqual({ table: "portal_outbound_mail_records", row: expect.objectContaining({
      row_data: expect.objectContaining({ emailSent: true, emailResendId: "test_workspace_captured" }),
    }) });
    expect(threads.get(threadId(services[0]))?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "sent" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the authorized quote reply failed when durable capture cannot retain audit evidence", async () => {
    const { writes, threads } = fixture();
    boundary.classify.mockResolvedValue({ kind: "classified", workspaceId: "durable-workspace", role: "manager", state: "active" });
    boundary.auditFails = true;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: false, deliveryState: "unsent" });
    expect(threads.get(threadId(services[0]))?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "failed" }));
    expect(writes.filter(({ table }) => table === "audit_log")).toEqual([]);
    expect(writes).toContainEqual({ table: "portal_outbound_mail_records", row: expect.objectContaining({
      row_data: expect.objectContaining({ emailSent: false, emailResendId: null }),
    }) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(services)("authorizes a selected folded source for $workOrderId and stores only on its canonical row", async (service) => {
    const { foldQuotes, threads, issued } = fixture(); foldQuotes();
    const fetch = vi.fn(async () => Response.json({ id: "captured" })); vi.stubGlobal("fetch", fetch);
    const response = await reply(service, VENDOR_EMAIL, service.workOrderId, { threadId: "generic-newer", quoteContextThreadId: threadId(service), recordRef: undefined });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: true, deliveryState: "sent" });
    expect(issued).toContainEqual(expect.objectContaining({ work_order_id: service.workOrderId, recipient_email: VENDOR_EMAIL }));
    expect(threads.has(threadId(service))).toBe(false);
    expect(threads.get("generic-newer")?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "sent", recordRef: expect.objectContaining({ id: service.workOrderId }) }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("authorizes a directory-only vendor solely through the current quote capability", async () => {
    const { foldQuotes } = fixture(false); foldQuotes();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "captured" })));
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(200);
  });
  it("does not extend directory-only quote authority to ordinary standalone compose", async () => {
    fixture(false); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined, recordRef: undefined })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not issue a reply capability before the owner plan gate succeeds", async () => {
    const { foldQuotes, issued, writes } = fixture(); foldQuotes(); boundary.planReadable = false;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0])).status).toBe(503);
    expect(issued).toEqual([]); expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts the original quote id after it becomes a durable alias", async () => {
    const { foldQuotes, threads } = fixture(); foldQuotes();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "captured" })));
    const response = await reply(services[1]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(threads.has(threadId(services[1]))).toBe(false);
  });
  it("does not downgrade a folded quote conversation to ordinary mail without a service selection", async () => {
    const { foldQuotes, writes, issued } = fixture(); foldQuotes();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-newer", recordRef: undefined })).status).toBe(409);
    expect(writes).toEqual([]); expect(issued).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["recipient_withdrawal", "hard_bounce", "complaint"])("keeps %s suppression authoritative after source rows are deleted", async (reason) => {
    const { foldQuotes, writes, issued, setSuppression } = fixture(); foldQuotes(); setSuppression(reason);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-newer", quoteContextThreadId: threadId(services[0]), recordRef: undefined })).status).toBe(409);
    expect(writes).toEqual([]); expect(issued).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a revoked capability after its quote row becomes an alias", async () => {
    const { foldQuotes, writes, issued, revokeCapability } = fixture(); foldQuotes(); revokeCapability(services[0].workOrderId);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0])).status).toBe(409);
    expect(writes).toEqual([]); expect(issued).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["owner", "recipient"])("refuses a folded source when its canonical %s differs", async (mismatch) => {
    const { foldQuotes, threads, writes, issued } = fixture(); foldQuotes();
    const row = threads.get("generic-newer")!;
    if (mismatch === "owner") row.owner_user_id = "other-manager";
    else row.row_data.email = "someone-else@example.test";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect([403, 409]).toContain(response.status);
    expect(writes).toEqual([]); expect(issued).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("saves a late refusal on the canonical target without resurrecting an absorbed quote", async () => {
    const { foldQuotes, threads, suppressOnAppend } = fixture(); foldQuotes(); suppressOnAppend();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: false, deliveryState: "unsent" });
    expect(threads.get("generic-newer")?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "failed" }));
    expect(threads.has(threadId(services[0]))).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("sends once using the service workspace through the real capability and transport", async () => {
    const { issued, threads } = fixture();
    const payloads: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { payloads.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: "captured" }), { status: 200 }); }));
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: true, deliveryState: "sent" });
    expect(threads.get(threadId(services[0]))?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "sent" }));
    expect(issued).toHaveLength(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ from: "Workspace One <one@example.test>", to: [VENDOR_EMAIL] });
    expect(payloads[0].reply_to).toMatch(/^vq\+[a-z2-7]{52}@reply\.example\.test$/);
  });
  it("retains native inbound replies without clearing recipient suppression", async () => {
    const { db, setSuppression, writes } = fixture();
    let replyTo = "";
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { replyTo = JSON.parse(String(init.body)).reply_to; return new Response(JSON.stringify({ id: "captured" }), { status: 200 }); }));
    expect((await reply(services[0])).status).toBe(200);
    setSuppression("recipient_withdrawal");
    expect(await ingestVendorQuoteInboundEmail(db as never, { emailId: "incoming", fromEmail: VENDOR_EMAIL, fromName: "Vendor", toEmails: [replyTo], subject: "Re: quote", receivedAt: "2026-10-18T14:00:00Z", text: "A question" }, {})).toEqual({ handled: true });
    expect(boundary.notify).toHaveBeenCalledWith(db, expect.objectContaining({ channel: "email", body: "A question" }));
    expect(writes.filter(({ table }) => table === "vendor_quote_email_permissions")).toHaveLength(0);
    expect((await reply(services[0])).status).toBe(409);
  });
  it.each(["recipient_withdrawal", "hard_bounce", "complaint", "error"])("blocks %s before append or issuance", async (reason) => {
    const { writes, issued, setSuppression, failPolicy } = fixture();
    if (reason === "error") failPolicy(); else setSuppression(reason);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0])).status).toBe(409);
    expect(writes).toEqual([]); expect(issued).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains an unsent reply when suppression arrives after append", async () => {
    const { writes, threads, suppressOnAppend } = fixture(); suppressOnAppend();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ emailSent: false, deliveryState: "unsent" });
    const saved = threads.get(threadId(services[0]))?.row_data.messages;
    expect(saved).toHaveLength(2);
    expect(saved).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "failed", body: "The copper supply pipe." }));
    expect(writes.some(({ table }) => table === "portal_inbox_thread_records")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["recipient_withdrawal", "hard_bounce", "complaint"])("record composer with omitted thread blocks %s", async (reason) => {
    const { writes, setSuppression } = fixture(); setSuppression(reason);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined, deliverToPortalInbox: true, eventCategory: "messages" });
    expect(response.status).toBe(409); expect(fetch).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it.each(services)("resolves omitted thread using $workOrderId rather than selected workspace", async (service) => {
    const { threads } = fixture();
    const fetch = vi.fn<(url: unknown, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: "captured" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const response = await reply(service, VENDOR_EMAIL, service.workOrderId, { threadId: undefined, deliverToPortalInbox: true, eventCategory: "messages" });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json(); expect(result.emailSent).toBe(true);
    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(payload.from).toContain(service.email); expect(payload.reply_to).toMatch(/^vq\+/);
    expect(threads.get(threadId(service))?.row_data.messages).toContainEqual(expect.objectContaining({ id: result.messageId, delivery: "sent" }));
  });
  it("rejects a generic thread id instead of bypassing a matching quote", async () => {
    const { writes } = fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-thread" })).status).toBe(409);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["forged-service", services[1].workOrderId])("rejects mismatched recordRef %s", async (ref) => {
    const { writes } = fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], VENDOR_EMAIL, ref);
    expect([403, 409]).toContain(response.status); expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects ambiguous matching quote threads", async () => {
    const { threads, writes } = fixture();
    const original = threads.get(threadId(services[0]))!;
    threads.set("vendor_quote_duplicate", { ...original, id: "vendor_quote_duplicate" });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined })).status).toBe(409);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("honors explicit email-off without external delivery even when suppressed", async () => {
    const { setSuppression } = fixture(); setSuppression("recipient_withdrawal");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { deliverViaEmail: false, eventCategory: "messages" })).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not globally suppress ordinary portal mail", async () => {
    const { setSuppression } = fixture(); setSuppression("recipient_withdrawal");
    const fetch = vi.fn<(url: unknown, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: "captured" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined, recordRef: undefined });
    expect(response.status, await response.clone().text()).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).reply_to).toMatch(/^reply\+/);
  });

  it("rejects a body-forged service owned by another manager", async () => {
    const { makeServiceForeign, writes } = fixture(); makeServiceForeign();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined })).status).toBe(403);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("persists the exact record-composer reply as failed after late suppression", async () => {
    const { threads, writes, suppressOnAppend } = fixture(); suppressOnAppend();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const sendId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: undefined, deliverToPortalInbox: true, eventCategory: "messages", sendId });
    expect(await response.json()).toMatchObject({ ok: true, emailSent: false, deliveryState: "unsent", messageId: `quote-reply:${sendId}` });
    expect(threads.get(threadId(services[0]))?.row_data.messages).toContainEqual(expect.objectContaining({ id: `quote-reply:${sendId}`, delivery: "failed" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(writes.filter(({ table }) => table === "portal_inbox_thread_records").every(({ row }) => row.id === threadId(services[0]))).toBe(true);
  });

  it.each(["recipient_withdrawal", "hard_bounce", "complaint"])("real collapse generic canonical cannot bypass %s", async (reason) => {
    const { threads, writes, setSuppression } = fixture(); setSuppression(reason);
    const collapsed = addGeneric(threads);
    expect(collapsed.id).toBe("generic-newer"); expect(collapsed.sourceThreadIds).toContain(threadId(services[0]));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: collapsed.id, recordRef: undefined })).status).toBe(409);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: collapsed.id, recordRef: undefined, quoteContextThreadId: threadId(services[0]) })).status).toBe(409);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(services)("real component collapse selects $workOrderId through actual POST and sender", async (service) => {
    const { threads } = fixture(); addGeneric(threads);
    boundary.uiThreads = collapsePersonInboxThreads(displayRows(threads), { mergeFolders: true });
    const provider = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ id: "captured" }));
    let requestBody: Record<string, unknown> = {};
    let routeResult = "not called";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/portal/send-inbox-message") {
        requestBody = JSON.parse(String(init?.body));
        const result = await POST(new Request(`http://localhost${url}`, { ...init, method: "POST" }));
        routeResult = await result.clone().text();
        boundary.uiThreads = collapsePersonInboxThreads(displayRows(threads), { mergeFolders: true });
        return result;
      }
      if (String(url).startsWith("https://api.resend.com/")) return provider(url, init);
      return Response.json({ ok: true, threads: [] });
    }));
    render(createElement(ManagerInbox, { tabId: "all", controlledExpandedId: "generic-newer", suppressListPane: true, embeddedInCommunication: true }));
    const composer = await screen.findByPlaceholderText("Write a reply…");
    fireEvent.change(composer, { target: { value: "The copper supply pipe." } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    expect(provider).not.toHaveBeenCalled();
    await pickSource(service.workOrderId);
    expect(screen.getByRole("button", { name: "Service", exact: true }).textContent).toContain(service.workOrderId);
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(provider, JSON.stringify({ requestBody, routeResult, toast: boundary.toast.mock.calls })).toHaveBeenCalledTimes(1));
    expect(requestBody).toMatchObject({ threadId: "generic-newer", quoteContextThreadId: threadId(service) });
    const payload = JSON.parse(String(provider.mock.calls[0]?.[1]?.body));
    expect(payload.from).toContain(service.email); expect(payload.reply_to).toMatch(/^vq\+/);
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    expect(threads.get(threadId(service))?.row_data.messages).toContainEqual(expect.objectContaining({ delivery: "sent", body: "The copper supply pipe." }));
    expect(threads.get("generic-newer")?.row_data.messages).toEqual([]);
  });
  it("actual component retains draft and failed persisted selected quote after late suppression", async () => {
    const { threads, suppressOnAppend } = fixture(); addGeneric(threads); suppressOnAppend(); boundary.uiThreads = collapsePersonInboxThreads(displayRows(threads), { mergeFolders: true });
    const provider = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/portal/send-inbox-message") {
        const result = await POST(new Request(`http://localhost${url}`, { ...init, method: "POST" }));
        boundary.uiThreads = collapsePersonInboxThreads(displayRows(threads), { mergeFolders: true }); return result;
      }
      if (String(url).startsWith("https://api.resend.com/")) return provider(url, init);
      return Response.json({ ok: true });
    }));
    render(createElement(ManagerInbox, { tabId: "all", controlledExpandedId: "generic-newer", suppressListPane: true, embeddedInCommunication: true }));
    const composer = await screen.findByPlaceholderText("Write a reply…");
    await pickSource(services[0].workOrderId);
    fireEvent.change(composer, { target: { value: "Please confirm." } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByText("Couldn't send");
    expect((composer as HTMLTextAreaElement).value).toBe("Please confirm."); expect(provider).not.toHaveBeenCalled();
    expect(threads.get(threadId(services[0]))?.row_data.messages).toContainEqual(expect.objectContaining({ delivery: "failed", body: "Please confirm." }));
    cleanup();
    render(createElement(ManagerInbox, { tabId: "all", controlledExpandedId: "generic-newer", suppressListPane: true, embeddedInCommunication: true }));
    expect(await screen.findByText("Couldn't send")).toBeTruthy();
  });
  it.each(["vendor_quote_forged", "generic-newer", "vendor_quote_foreign"])("rejects forged source %s", async (selection) => {
    const { threads, writes } = fixture(); addGeneric(threads);
    const row = threads.get(threadId(services[0]))!;
    threads.set("vendor_quote_foreign", { ...row, id: "vendor_quote_foreign", owner_user_id: "other-manager" });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect([400, 409]).toContain((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-newer", recordRef: undefined, quoteContextThreadId: selection })).status);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on source lookup failure", async () => {
    const { threads, failPersonLookup, writes } = fixture(); addGeneric(threads); failPersonLookup();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-newer", recordRef: undefined, quoteContextThreadId: threadId(services[0]) })).status).toBe(409);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps ordinary standalone threaded mail on generic transport", async () => {
    const { threads, setSuppression } = fixture(); addGeneric(threads); setSuppression("recipient_withdrawal");
    for (const service of services) threads.delete(threadId(service));
    const fetch = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () => Response.json({ id: "captured" })); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], VENDOR_EMAIL, services[0].workOrderId, { threadId: "generic-newer", recordRef: undefined });
    expect(response.status, await response.clone().text()).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).reply_to).toMatch(/^reply\+/);
  });
  it.each(["trash", "other-person", "wrong-recipient"])("rejects selected source outside the display person group: %s", async (reason) => {
    const { threads, writes } = fixture(); addGeneric(threads);
    const quote = threads.get(threadId(services[0]))!;
    if (reason === "trash") quote.row_data.folder = "trash";
    if (reason === "other-person") quote.row_data.email = "another@example.test";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0], reason === "wrong-recipient" ? "another@example.test" : VENDOR_EMAIL, services[0].workOrderId,
      { threadId: "generic-newer", recordRef: undefined, quoteContextThreadId: threadId(services[0]) });
    expect([403, 409]).toContain(response.status); expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

});
