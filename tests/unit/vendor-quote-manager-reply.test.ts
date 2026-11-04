import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  planReadable: true, auth: vi.fn(), service: vi.fn(), issueReply: vi.fn(), workEmail: vi.fn(), sendNumber: vi.fn(),
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
  assertTestWorkspacePrincipalCompatibility: vi.fn(async () => undefined),
}));
vi.mock("@/lib/vendor-quote-contact.server", () => ({
  buildVendorQuoteInboundReplyAddress: boundary.issueReply,
  loadVendorQuoteInboundReplyCapability: boundary.loadReply,
  isVendorQuoteOutboundReplyAuthorized: boundary.outboundReply,
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

import { POST } from "@/app/api/portal/send-inbox-message/route";
import { ingestVendorQuoteInboundEmail } from "@/lib/vendor-quote-inbound-email.server";
import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const VENDOR_EMAIL = "vendor@example.test";
const services = [
  { workOrderId: "service-one", directoryId: "directory-one", candidateId: "candidate-one", proposalId: "proposal-one", workspaceId: "workspace-one", email: "one@example.test" },
  { workOrderId: "service-two", directoryId: "directory-two", candidateId: "candidate-two", proposalId: "proposal-two", workspaceId: "workspace-two", email: "managed@example.test" },
] as const;
const threadId = (service: typeof services[number]) => `vendor_quote_${service.workOrderId}_${service.directoryId}`;
const tokenFor = (service: typeof services[number]) => (service === services[0] ? "a" : "b").repeat(52);

function fixture(linkedVendor = true) {
  let managedMode = false;
  let suppression: string | null = null;
  let policyError = false;
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
          return service ? [{ manager_user_id: MANAGER, property_id: `property-${service.workspaceId}` }] : [];
        }
        if (table === "manager_property_records") {
          const service = services.find((item) => `property-${item.workspaceId}` === filters.get("id"));
          return service ? [{ manager_user_id: MANAGER, workspace_id: service.workspaceId }] : [];
        }
        if (table === "manager_sms_numbers") return [{ phone_number: "+15550000001", messaging_service_sid: "MGmanaged",
          provision_state: "active", released_at: null, workspace_id: filters.get("workspace_id") }];
        if (table === "profile_roles") return filters.get("role") === "resident" ? [] : [{ role: "manager" }];
        if (table === "manager_vendor_records") return [{ manager_user_id: MANAGER, vendor_user_id: linkedVendor ? "vendor-user" : null, row_data: { email: VENDOR_EMAIL } }];
        if (table === "portal_inbox_thread_records") return [...threads.values()].filter((row) => [...filters].every(([key, value]) => row[key as keyof typeof row] === value));
        if (table === "vendor_quote_contact_capabilities") {
          const service = services.find((item) => `cap-${item.workOrderId}` === filters.get("id"));
          return service ? [{ id: `cap-${service.workOrderId}`, expires_at: "2099-01-01T00:00:00.000Z", manager_user_id: MANAGER,
            work_order_id: service.workOrderId, candidate_id: service.candidateId,
            vendor_directory_id: service.directoryId, proposal_id: service.proposalId, recipient_email: VENDOR_EMAIL }] : [];
        }
        if (table === "vendor_sourcing_candidates" || table === "work_order_vendor_offers") return [{ expires_at: "2030-01-01T00:00:00.000Z" }];
        return [];
      };
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((key: string, value: unknown) => { filters.set(key, value); return query; }),
        in: vi.fn(() => query), ilike: vi.fn(() => query), or: vi.fn(() => query),
        order: vi.fn(() => query), limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: rows()[0] ?? null, error: null })),
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: rows(), error: table === "vendor_quote_email_permissions" && policyError ? { message: "unavailable" } : null }).then(resolve),
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
  return { db, writes, setSuppression: (value: string | null) => { suppression = value; },
    failPolicy: () => { policyError = true; }, suppressOnAppend: () => { suppressAfterAppend = true; }, setManagedMode: (value: boolean) => { managedMode = value; },
    deleteQuoteMarker: (service: typeof services[number]) => {
      const thread = threads.get(threadId(service));
      if (thread) delete (thread.row_data as { quoteCapabilityId?: string }).quoteCapabilityId;
    } };
}

function reply(service: typeof services[number], toEmail = VENDOR_EMAIL, recordRefId = service.workOrderId) {
  return POST(new Request("http://localhost/api/portal/send-inbox-message", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: threadId(service), senderPortal: "manager", fromName: "Workspace One",
      toEmails: [toEmail], subject: `Re: ${service.workOrderId}`, text: "The copper supply pipe.",
      deliverViaEmail: true, deliverViaSms: false, deliverToPortalInbox: false,
      recordRef: { kind: "service", id: recordRefId, label: recordRefId } }),
  }));
}

describe("manager quote email roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks(); boundary.planReadable = true;
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("RESEND_REPLY_DOMAIN", "reply.example.test");
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", `whsec_${Buffer.from("test-secret-key").toString("base64")}`);
    boundary.auth.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: MANAGER, email: "manager@example.test" } } })) } });
    boundary.workEmail.mockImplementation(async (_db, _owner, workspaceId) => {
      const service = services.find((item) => item.workspaceId === (workspaceId ?? "workspace-two"));
      return service ? { address: service.email, workspaceId: service.workspaceId } : null;
    });
    boundary.sendNumber.mockResolvedValue("+15550000001");
    boundary.issueReply.mockImplementation(async (_db, input) => {
      const service = services.find((item) => item.workOrderId === input.workOrderId);
      return { address: `vq+${tokenFor(service!)}@reply.example.test`, capabilityId: `reply-${input.workOrderId}` };
    });
    boundary.loadReply.mockImplementation(async (_db, input) => {
      const service = services.find((item) => tokenFor(item) === input.token && input.fromEmail === VENDOR_EMAIL);
      return service ? { capabilityId: `reply-${service.workOrderId}`, candidateId: service.candidateId,
        managerUserId: MANAGER, workOrderId: service.workOrderId } : null;
    });
    boundary.notify.mockResolvedValue(undefined);
    boundary.outboundReply.mockResolvedValue(true);
  });

  it("reproduces the prior pair Reply-To and selected-workspace sender in the real transport", async () => {
    const { db, setManagedMode } = fixture();
    setManagedMode(true);
    const payloads: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payloads.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "legacy-captured" }), { status: 200 });
    }));
    const oldFrom = await resolveManagerOutboundFrom(db as never, MANAGER);
    await sendPortalConversationEmails({ senderUserId: MANAGER, toEmails: [VENDOR_EMAIL],
      subject: "Re: service-one", text: "The copper supply pipe.", html: "<p>The copper supply pipe.</p>",
      fromAddress: oldFrom });

    // The selected cookie points to workspace two while service one belongs to workspace one.
    // The old route passed these exact arguments and replaced vq+ with a person-pair token.
    expect(boundary.workEmail).toHaveBeenCalledWith(db, MANAGER);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ from: "Workspace One <managed@example.test>", to: [VENDOR_EMAIL] });
    expect(String(payloads[0]!.reply_to)).toMatch(/^reply\+[a-f0-9]{32}\.[a-f0-9]{16}@reply\.example\.test$/);
    expect(String(payloads[0]!.reply_to)).not.toMatch(/^vq\+/);
  });

  it("sends two service replies from their own workspaces and routes the next vendor replies back to each service", async () => {
    const { db, writes, setManagedMode } = fixture();
    const payloads: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payloads.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `captured-${payloads.length}` }), { status: 200 });
    }));
    for (const service of services) {
      setManagedMode(service === services[1]);
      // The record context must agree with the persisted quote conversation.
      const response = await reply(service);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ from: "Workspace One <one@example.test>", to: [VENDOR_EMAIL], reply_to: `vq+${tokenFor(services[0])}@reply.example.test` });
    expect(payloads[1]).toMatchObject({ from: "Managed Desk <managed@example.test>", to: [VENDOR_EMAIL], reply_to: `vq+${tokenFor(services[1])}@reply.example.test` });
    expect(String(payloads[1]!.html)).toContain("Sent via PropLane portal by Managed Desk");
    expect((payloads[0]!.headers as Record<string, string>).References).not.toBe((payloads[1]!.headers as Record<string, string>).References);
    expect(boundary.issueReply).toHaveBeenCalledWith(db, expect.objectContaining({ workOrderId: services[1].workOrderId, directoryId: services[1].directoryId }));
    expect(boundary.workEmail).toHaveBeenCalledWith(db, MANAGER, "workspace-one");
    expect(boundary.workEmail).toHaveBeenCalledWith(db, MANAGER, "workspace-two");
    expect(writes.filter(({ table }) => table === "portal_inbox_thread_records")).toHaveLength(4);
    for (const [index, service] of services.entries()) {
      const result = await ingestVendorQuoteInboundEmail(db as never, {
        emailId: `vendor-reply-${index}`, fromEmail: VENDOR_EMAIL, fromName: "Vendor",
        toEmails: [String(payloads[index]!.reply_to)], subject: "Re: Service quote",
        receivedAt: "2026-10-18T14:00:00.000Z", text: `Reply for ${service.workOrderId}`,
      }, {});
      expect(result).toEqual({ handled: true });
      expect(boundary.notify).toHaveBeenCalledWith(db, expect.objectContaining({
        capabilityId: `reply-${service.workOrderId}`, body: `Reply for ${service.workOrderId}`,
      }));
    }
  });

  it("rejects an unrelated recipient before appending or sending", async () => {
    const { writes } = fixture();
    const response = await reply(services[0], "unrelated@example.test");
    expect([403, 409], await response.clone().text()).toContain(response.status);
    expect(writes).toEqual([]);
    expect(boundary.issueReply).not.toHaveBeenCalled();
  });

  it("fails closed when the current service sender is unavailable", async () => {
    const { db, writes } = fixture();
    boundary.workEmail.mockResolvedValue(null);
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(writes).toEqual([]);
    expect(db.from).toHaveBeenCalledWith("vendor_quote_contact_capabilities");
  });

  it("refuses an unbound quote thread even when the request body names a service", async () => {
    const { writes, deleteQuoteMarker } = fixture();
    deleteQuoteMarker(services[0]);
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(writes).toEqual([]);
    expect(boundary.issueReply).not.toHaveBeenCalled();
  });

  it("suppresses provider delivery when the issued conversation closes before handoff", async () => {
    fixture();
    boundary.outboundReply.mockResolvedValue(false);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hand mail to Resend when the service sender changes after the inbox append", async () => {
    const { writes } = fixture();
    const normal = boundary.workEmail.getMockImplementation()!;
    let calls = 0;
    boundary.workEmail.mockImplementation(async (...args) => {
      calls += 1;
      return calls >= 3 ? null : normal(...args);
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(writes.some(({ table }) => table === "portal_inbox_thread_records")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["recipient_withdrawal", "hard_bounce", "complaint"])("blocks %s before append even under a revised managed sender", async (reason) => {
    const { writes, setSuppression, setManagedMode } = fixture();
    setSuppression(reason); setManagedMode(true);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status).toBe(409);
    expect(writes).toEqual([]);
    expect(boundary.issueReply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed before append when permission lookup fails", async () => {
    const { writes, failPolicy } = fixture(); failPolicy();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await reply(services[0])).status).toBe(409);
    expect(writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it("retains an unsent reply when withdrawal arrives after append, without capture or fetch", async () => {
    const { writes, suppressOnAppend } = fixture(); suppressOnAppend();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await reply(services[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ emailSent: false, deliveryState: "unsent" });
    expect(writes.some(({ table }) => table === "portal_inbox_thread_records")).toBe(true);
    expect(writes.find(({ table }) => table === "portal_outbound_mail_records")?.row.row_data).toMatchObject({ emailSent: false });
    expect(fetch).not.toHaveBeenCalled();
  });

});
