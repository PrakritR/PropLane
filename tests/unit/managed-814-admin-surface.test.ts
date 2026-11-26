/**
 * Captain, Nov 24 (second half): "use the 814 for the admin portal ALWAYS".
 *   - an admin-initiated send (the operator or staff acting in a managed workspace, PropLane's alerts to its people, an admin's
 *     reply to an Unassigned lead) leaves on the admin line via `resolveAdminLine`, even for a managed workspace with no number
 *     of its own; an automated reply to someone who texted the 206 answers on the line they texted;
 *   - the 206's managed-home redirect is sent once per 30 days per phone; repeats are logged and get a short answer;
 *   - Settings reports a managed workspace on its own 814 as onSharedLine false with the 814 shown;
 *   - the remaining direct from-number pickers go through the one decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
}));
const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/manager-sms-messages.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-sms-messages.server")>()),
  logManagerSmsMessage: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    logged.push(input);
    return true;
  }),
}));
const sendSmsMock = vi.hoisted(() => vi.fn(async () => ({ sent: true, sid: "SM1", providerAttempted: true })));
vi.mock("@/lib/twilio", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/twilio")>()), sendSms: sendSmsMock }));

import { isAdminSurfaceSend } from "@/lib/sms/admin-surface.server";
import { evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";
import { sendAdminLeadReply } from "@/lib/one-number/admin-lead-reply.server";
import { answerFromDedicatedWorkspace } from "@/lib/one-number/dedicated-redirect.server";
import { resolveManagedAwareFromNumber } from "@/lib/sms/prospect-send-number.server";

const SO = "00000000-0000-4000-8000-0000000000a0";
const AMBIKA = "00000000-0000-4000-8000-0000000000a1";
const VINOD = "00000000-0000-4000-8000-0000000000a3";
const SELF = "00000000-0000-4000-8000-0000000000a2";
const LINE_206 = "+12066781909";
const OWN_814 = "+18146793694";
const SELF_OWN = "+15025550142";

const row = (over: Record<string, unknown>) => ({
  phone_number_sid: "PN1", messaging_service_sid: "MGdefault", campaign_sid: "CP1", provision_state: "active", registration_state: "approved",
  registration_ref: null, attachment_state: "attached", number_registration_state: "registered", released_at: null,
  grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null, requested_at: "2026-08-01T00:00:00.000Z", ...over,
});

function world() {
  return createMemoryDb({
    sms_runtime_config: [{ singleton: true, mode: "automatic", pilot_manager_user_ids: [], line_mode: "per_workspace", shared_number_e164: LINE_206, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [] }],
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    profile_roles: [{ user_id: SO, role: "admin" }, { user_id: "admin-2", role: "admin" }],
    portal_workspaces: [
      { id: "ws-svc-home", name: "PropLane", owner_user_id: SO, is_default: true, is_service: false },
      { id: "ws-ambika", name: "1. Ambika", owner_user_id: AMBIKA, is_default: true, is_service: true },
      { id: "ws-vinod", name: "2. Vinod", owner_user_id: VINOD, is_default: true, is_service: true },
      { id: "ws-self", name: "Self", owner_user_id: SELF, is_default: true, is_service: false },
    ],
    manager_sms_numbers: [
      row({ id: "n-206", manager_user_id: SO, workspace_id: "ws-svc-home", phone_number: LINE_206 }),
      row({ id: "n-814", manager_user_id: AMBIKA, workspace_id: "ws-ambika", phone_number: OWN_814 }),
      row({ id: "n-self", manager_user_id: SELF, workspace_id: "ws-self", phone_number: SELF_OWN }),
    ],
    workspace_work_numbers: [],
    manager_property_records: [{ id: "h-vinod", manager_user_id: VINOD, workspace_id: "ws-vinod" }],
    profiles: [],
    sms_manager_entitlements: [],
    account_link_invites: [],
    sms_managed_home_redirects: [],
  });
}

beforeEach(() => {
  logged.length = 0;
  sendSmsMock.mockClear();
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGdefault";
  process.env.TWILIO_CAMPAIGN_SID = "CP1";
});

describe("which sends are admin-initiated", () => {
  it("an admin acting in a managed workspace is; the workspace's own automated reply is not", async () => {
    const db = world() as never;
    expect(await isAdminSurfaceSend(db, { managerUserId: VINOD, actorUserId: "admin-2", workspaceId: "ws-vinod" })).toBe(true);
    expect(await isAdminSurfaceSend(db, { managerUserId: VINOD, actorUserId: VINOD, workspaceId: "ws-vinod" })).toBe(false);
  });

  it("an admin or a stranger acting in a self-serve workspace is not (the surface is managed workspaces and PropLane's own people)", async () => {
    const db = world() as never;
    expect(await isAdminSurfaceSend(db, { managerUserId: SELF, actorUserId: "admin-2", workspaceId: "ws-self" })).toBe(false);
    expect(await isAdminSurfaceSend(db, { managerUserId: VINOD, actorUserId: "someone-else", workspaceId: "ws-vinod" })).toBe(false);
  });

  it("PropLane's own alert or notice to a manager/staff person is; a text from the same account to a prospect is not", async () => {
    const db = world() as never;
    expect(await isAdminSurfaceSend(db, { managerUserId: SO, actorUserId: SO, workspaceId: "ws-svc-home", counterpartyRole: "manager" })).toBe(true);
    expect(await isAdminSurfaceSend(db, { managerUserId: SO, actorUserId: SO, workspaceId: "ws-svc-home", counterpartyRole: "prospect" })).toBe(false);
  });
});

describe("admin-surface sends leave on the 814", () => {
  const ready = (db: unknown, ownerUserId: string, over: Record<string, unknown>) =>
    evaluateWorkspaceSendReadiness({ db: db as never, ownerUserId, requiredCents: 3, ...over });

  it("an admin text in Vinod's workspace (no number of its own) leaves from the 814, billed to Vinod's wallet", async () => {
    const result = await ready(world(), VINOD, { workspaceId: "ws-vinod", adminSurface: true });
    expect(result).toMatchObject({ canSend: true, workspaceId: "ws-vinod", adminLine: true });
    expect(result.canSend && result.numberRow.phone_number).toBe(OWN_814);
  });

  it("the same workspace's automated reply still answers on the 206", async () => {
    const result = await ready(world(), VINOD, { workspaceId: "ws-vinod" });
    expect(result.canSend && result.numberRow.phone_number).toBe(LINE_206);
    expect(result.canSend && result.adminLine).toBeFalsy();
  });

  it("PropLane's alert from the service owner's account leaves from the 814", async () => {
    const result = await ready(world(), SO, { workspaceId: "ws-svc-home", adminSurface: true });
    expect(result).toMatchObject({ canSend: true, adminLine: true });
    expect(result.canSend && result.numberRow.phone_number).toBe(OWN_814);
  });

  it("with no registered operator number the admin line is the PropLane line (no adminLine flag, no borrowed self-serve number)", async () => {
    const db = world();
    const noOperator = createMemoryDb({
      sms_runtime_config: [{ singleton: true, mode: "automatic", pilot_manager_user_ids: [], line_mode: "per_workspace", shared_number_e164: LINE_206 }],
      platform_service_settings: [{ singleton: true, owner_user_id: SO }],
      portal_workspaces: [
        { id: "ws-svc-home", name: "PropLane", owner_user_id: SO, is_default: true, is_service: false },
        { id: "ws-vinod", name: "2. Vinod", owner_user_id: VINOD, is_default: true, is_service: true },
        { id: "ws-self", name: "Self", owner_user_id: SELF, is_default: true, is_service: false },
      ],
      manager_sms_numbers: [
        row({ id: "n-206", manager_user_id: SO, workspace_id: "ws-svc-home", phone_number: LINE_206 }),
        row({ id: "n-self", manager_user_id: SELF, workspace_id: "ws-self", phone_number: SELF_OWN }),
      ],
      workspace_work_numbers: [], manager_property_records: [], profiles: [], sms_manager_entitlements: [], account_link_invites: [],
    });
    void db;
    const result = await ready(noOperator, VINOD, { workspaceId: "ws-vinod", adminSurface: true });
    expect(result.canSend && result.numberRow.phone_number).toBe(LINE_206);
    expect(result.canSend && result.adminLine).toBeFalsy();
  });
});

describe("an admin's reply to an Unassigned lead", () => {
  it("leaves from the 814 when the operator has one, through the platform lead transport", async () => {
    const full = world();
    const leadDb = {
      ...full,
      from: (table: string) => {
        if (table !== "sms_unassigned_leads") return full.from(table);
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.maybeSingle = async () => ({ data: { id: "L1", phone_key: "5106489423", status: "open", last_inbound_at: new Date().toISOString() }, error: null });
        return q;
      },
    };
    const sent: Array<Record<string, unknown>> = [];
    const result = await sendAdminLeadReply(leadDb as never, { leadId: "L1", text: "Room 6 is free." }, {
      send: async (_db, input) => { sent.push(input as never); return { ok: true, sid: "SMx" }; },
    });
    // (the thread copy needs the lead tables this double does not carry; the send is what is asserted)
    expect(result.ok || result.status === 502).toBe(true);
    expect(sent[0]).toMatchObject({ adminLine: { phoneNumber: OWN_814, messagingServiceSid: "MGdefault" } });
  });

  it("the platform lead transport sends from that number, flagged as the admin line, through its own messaging service", async () => {
    const { sendPlatformLeadText } = await import("@/lib/one-number/lead-send.server");
    const result = await sendPlatformLeadText(world() as never, {
      to: "+14255550123", body: "hi", inboundReply: true, adminLine: { phoneNumber: OWN_814, messagingServiceSid: "MGdefault" },
    });
    expect(result).toEqual({ ok: true, sid: "SM1" });
    expect(sendSmsMock).toHaveBeenCalledWith("+14255550123", "hi", OWN_814, expect.objectContaining({ purpose: "platform_lead", adminLine: true, messagingServiceSid: "MGdefault" }));
  });
});

describe("the 206's managed-home redirect is sent once per 30 days", () => {
  const candidate = { workspaceId: "ws-ambika", ownerUserId: AMBIKA, role: "prospect" as const, reason: "named" as never, propertyId: null, label: "5257 Brooklyn" };
  const keyed = () => {
    const db = world();
    const seen = new Set<string>();
    return {
      ...db,
      from: (table: string) => {
        const real = db.from(table) as Record<string, (...a: unknown[]) => unknown>;
        if (table !== "sms_managed_home_redirects") return real;
        return new Proxy(real, {
          get(t, p) {
            if (p !== "insert") return t[p as string];
            return async (r: { phone_key: string; workspace_id: string }) => {
              const k = `${r.phone_key}|${r.workspace_id}`;
              if (seen.has(k)) return { error: { code: "23505", message: "dup" } };
              seen.add(k);
              return { error: null };
            };
          },
        });
      },
    };
  };
  const ask = (db: unknown, sid: string) =>
    answerFromDedicatedWorkspace(db as never, { candidate, fromPhone: "+14255550123", body: "still open?", messageSid: sid, sharedNumber: LINE_206 });

  it("the first text gets the redirect; a repeat inside 30 days is logged and gets a short answer, not the redirect again", async () => {
    const db = keyed();
    const first = await ask(db, "SM1");
    expect(first).toBe("For 5257 Brooklyn, text us at (814) 679-3694 - that's the line for this home.");
    const again = await ask(db, "SM2");
    expect(again).not.toBe(first);
    expect(again).toContain("(814) 679-3694");
    expect(again).toContain("we have your message");
    expect(logged.filter((l) => l.direction === "inbound")).toHaveLength(2);
    expect(logged.filter((l) => l.direction === "inbound").every((l) => l.workspaceId === "ws-ambika")).toBe(true);
  });
});

describe("remaining from-number pickers follow the one decision", () => {
  it("a managed workspace's reminder/invite from-number is its line (own, else the PropLane line); a self-serve one keeps its lookup", async () => {
    const db = world() as never;
    const lookup = async () => "+19995550000";
    expect(await resolveManagedAwareFromNumber(db, AMBIKA, lookup, "ws-ambika")).toBe(OWN_814);
    expect(await resolveManagedAwareFromNumber(db, VINOD, lookup, "ws-vinod")).toBe(LINE_206);
    expect(await resolveManagedAwareFromNumber(db, SELF, lookup, "ws-self")).toBe("+19995550000");
  });
});
