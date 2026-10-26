// message_vendor: a confirm-first text to ONE roster vendor, sent through the single roster path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  status: { optedOut: false, needsAttestation: false, workNumber: null as string | null },
  sendResult: { status: 200, body: { ok: true, status: "queued", outboxId: "ob-1" } as Record<string, unknown> },
}));
vi.mock("@/lib/manager-sms-send.server", () => ({
  readRosterVendorTextStatus: vi.fn(async () => ({ status: 200, body: { ok: true, ...h.status } })),
  sendManagerConversationSms: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
    h.sends.push(args);
    return h.sendResult;
  }),
}));
vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: () => null }));

import { messageVendorTool } from "@/lib/tools/domains/vendor-message";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { CO_MANAGER_SCOPED_TOOLS, scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";
import { providerDestinationFor } from "@/lib/sms/owner-sms-dispatcher.server";
import type { AgentContext } from "@/lib/tools/context";
import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";

const MANAGER = "mgr-1";
const vendor = (id: string, name: string, extra: Row = {}, owner = MANAGER): Row => ({
  id, manager_user_id: owner, vendor_user_id: null,
  row_data: { id, managerUserId: owner, name, trade: "Plumbing", phone: "(206) 555-0142", email: "", notes: "", active: true, ...extra },
});

let db: ReturnType<typeof createFakeDb>;
const ctxFor = (overrides: Partial<AgentContext> = {}) =>
  ({ landlordId: MANAGER, userId: MANAGER, email: "m@x.test", roles: ["manager"], isAdmin: false, db, ...overrides }) as unknown as AgentContext;

beforeEach(() => {
  h.sends.length = 0;
  h.status = { optedOut: false, needsAttestation: false, workNumber: null };
  h.sendResult = { status: 200, body: { ok: true, status: "queued", outboxId: "ob-1" } };
  db = createFakeDb({
    audit_log: [],
    manager_vendor_records: [
      vendor("v-mike", "Mike's Plumbing"),
      vendor("v-spark", "Spark Electric", { trade: "Electrical", phone: "2065550199" }),
      vendor("v-spark2", "Spark Electric West", { trade: "Electrical", phone: "2065550177" }),
      vendor("v-other", "Other Manager Plumbing", {}, "mgr-2"),
    ],
  });
});

describe("message_vendor", () => {
  it("previews the text and pins the roster record, sending nothing", async () => {
    const preview = await messageVendorTool.preview(ctxFor(), { vendor: "mike", message: "Does Tuesday 10am work?" });
    expect(preview.summary).toBe(`Text Mike's Plumbing: "Does Tuesday 10am work?"`);
    expect(preview.kind).toBe("message_vendor");
    expect(preview.fields).toContainEqual({ label: "Message", value: "Does Tuesday 10am work?" });
    expect(preview.confirmedInput).toEqual({ vendor: "v-mike", message: "Does Tuesday 10am work?" });
    expect(h.sends).toHaveLength(0);
  });

  it("a vendor without a dedicated number is texted at the real phone through the roster path", async () => {
    const result = await messageVendorTool.handler(ctxFor(), { vendor: "v-mike", message: "Does Tuesday 10am work?" });
    expect(result).toMatchObject({ reply: "Text to Mike's Plumbing queued." });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      actorUserId: MANAGER, vendorRecordId: "v-mike", toPhone: "+12065550142", text: "Does Tuesday 10am work?", scopeManagerIds: [MANAGER],
    });
  });

  it("a vendor with a routable PropLane number: the card says so and the dispatcher delivers to that number", async () => {
    h.status.workNumber = "+14255550177";
    const preview = await messageVendorTool.preview(ctxFor(), { vendor: "v-mike", message: "Hi" });
    expect(preview.fields).toContainEqual({ label: "Delivery", value: "SMS from your work line to their PropLane number" });
    const identity: Row = { id: "i1", vendor_user_id: "vendor-1", phone_number: "+14255550177", sms_state: "ready", attachment_state: "attached", sms_send_ready: true, sms_receive_ready: true };
    const sub: Row = { owner_user_id: "vendor-1", owner_role: "vendor", status: "active", updated_at: new Date().toISOString(), stripe_customer_id: "c", stripe_subscription_id: "s" };
    const row = { counterparty_role: "vendor", purpose: "vendor_conversation", recipient_user_id: "vendor-1", recipient_phone: "+12065550142" } as never;
    const routable = createFakeDb({ vendor_work_identities: [identity], number_subscriptions: [sub] }) as unknown as SupabaseClient;
    const none = createFakeDb({ vendor_work_identities: [], number_subscriptions: [] }) as unknown as SupabaseClient;
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    expect(await providerDestinationFor(routable, row)).toBe("+14255550177");
    expect(await providerDestinationFor(none, row)).toBe("+12065550142");
    vi.unstubAllEnvs();
  });

  it("refuses a vendor that is not on the roster, another manager's vendor, and sends nothing", async () => {
    await expect(messageVendorTool.preview(ctxFor(), { vendor: "Acme Roofing", message: "Hi" })).rejects.toThrow(/not on your vendor list/);
    await expect(messageVendorTool.handler(ctxFor(), { vendor: "Acme Roofing", message: "Hi" })).rejects.toThrow(/not on your vendor list/);
    await expect(messageVendorTool.handler(ctxFor(), { vendor: "v-other", message: "Hi" })).rejects.toThrow(/not on your vendor list/);
    await expect(messageVendorTool.handler(ctxFor(), { vendor: "Other Manager Plumbing", message: "Hi" })).rejects.toThrow(/not on your vendor list/);
    expect(h.sends).toHaveLength(0);
  });

  it("refuses an ambiguous name and lists the candidates", async () => {
    await expect(messageVendorTool.preview(ctxFor(), { vendor: "spark", message: "Hi" })).rejects.toThrow(/More than one vendor matches.*Spark Electric, Spark Electric West/);
    await expect(messageVendorTool.handler(ctxFor(), { vendor: "spark", message: "Hi" })).rejects.toThrow(/More than one/);
    expect(h.sends).toHaveLength(0);
  });

  it("an exact name beats a longer partial match", async () => {
    await messageVendorTool.handler(ctxFor(), { vendor: "Spark Electric", message: "Hi" });
    expect(h.sends[0]).toMatchObject({ vendorRecordId: "v-spark" });
  });

  it("refuses an opted-out vendor and surfaces a failed send", async () => {
    h.status.optedOut = true;
    await expect(messageVendorTool.preview(ctxFor(), { vendor: "v-mike", message: "Hi" })).rejects.toThrow(/opted out/);
    h.status.optedOut = false;
    h.sendResult = { status: 409, body: { error: "That number has opted out of texts." } };
    await expect(messageVendorTool.handler(ctxFor(), { vendor: "v-mike", message: "Hi" })).rejects.toThrow(/opted out/);
  });

  it("a first text discloses the attestation on the card", async () => {
    h.status.needsAttestation = true;
    const preview = await messageVendorTool.preview(ctxFor(), { vendor: "v-mike", message: "Hi" });
    expect(preview.fields.some((f) => f.label === "First text")).toBe(true);
  });
});

describe("message_vendor registries and scope", () => {
  const access = (over: Partial<ManagerSmsAccess>) => ({ mode: "owner", readOnly: false, ...over }) as ManagerSmsAccess;

  it("is a non-destructive write tool on the portal and manager SMS registries", () => {
    const tool = agentRegistry.get("message_vendor");
    expect(tool?.kind).toBe("write");
    expect(tool?.kind === "write" && tool.destructive).toBeFalsy();
    expect(buildManagerSmsRegistry().has("message_vendor")).toBe(true);
    expect(buildManagerSmsRegistry(access({})).has("message_vendor")).toBe(true);
  });

  it("is absent for a read-only seat", () => {
    expect(buildManagerSmsRegistry(access({ readOnly: true })).has("message_vendor")).toBe(false);
  });

  it("is withheld from a delegated co-manager: not in the scoped set, and the scope wrapper refuses it", async () => {
    expect(CO_MANAGER_SCOPED_TOOLS.has("message_vendor")).toBe(false);
    expect(buildManagerSmsRegistry(access({ mode: "delegated" })).has("message_vendor")).toBe(false);
    const scoped = scopeManagerTool(messageVendorTool);
    const delegated = ctxFor({ managerSmsAccess: access({ mode: "delegated" }) });
    if (scoped.kind !== "write") throw new Error("write expected");
    await expect(scoped.handler(delegated, { vendor: "v-mike", message: "Hi" })).rejects.toThrow();
    expect(h.sends).toHaveLength(0);
  });
});
