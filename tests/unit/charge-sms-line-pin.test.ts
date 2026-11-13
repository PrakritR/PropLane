/**
 * A text about one HOUSE (the `charge_created` action event, a reminder) leaves from that house's workspace line.
 * `deliverPortalInboxMessage` resolves the pin from the STORED house (never the request) through the existing resolver
 * (`resolveWorkspaceSendLine`, which answers a PropLane-managed `is_service` workspace with the PropLane line) and hands the
 * house, workspace, actor and pinned line to the SMS transport. No house = the sender's own default line, as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  line: { phoneNumber: "+12065550199", numberId: "num-service" } as { phoneNumber: string; numberId: string | null } | null,
  lineError: false,
  workspaceId: "ws-managed" as string | null,
  senderFrom: "",
}));

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn().mockResolvedValue({ sent: 0 }) }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: (from: string) => Boolean(from),
  sendResidentOutboundSms: async (args: Record<string, unknown>) => {
    h.sends.push(args);
    return { sent: true, accepted: true, channel: "twilio", outboxStatus: "queued" };
  },
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => {
    if (h.lineError) throw new Error("workspace_line_unreadable");
    return h.line;
  },
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { resolvePropertySendPin } from "@/lib/sms/property-send-pin.server";

type Row = Record<string, unknown>;

function fakeDb() {
  const tables: Record<string, Row[]> = {
    profiles: [
      { id: "owner-1", email: "owner@axis.test", role: "manager", sms_from_number: h.senderFrom },
      { id: "res-1", email: "res1@axis.test", role: "resident", phone: "+12065550142" },
    ],
    manager_property_records: [{ id: "prop-1", workspace_id: "ws-managed" }],
  };
  const make = (table: string) => {
    const eq: Array<[string, unknown]> = [];
    const inn: Array<[string, unknown[]]> = [];
    const rows = () => tables[table] ?? [];
    const match = (r: Row) => eq.every(([c, v]) => r[c] === v) && inn.every(([c, vs]) => vs.includes(r[c]));
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      limit: () => q,
      not: () => q,
      eq: (c: string, v: unknown) => (eq.push([c, v]), q),
      in: (c: string, vs: unknown[]) => (inn.push([c, vs]), q),
      maybeSingle: async () => ({ data: (table === "manager_property_records" && !h.workspaceId ? { workspace_id: null } : rows().find(match)) ?? null, error: null }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows().filter(match), error: null }).then(resolve),
    };
    return q;
  };
  return { from: make } as unknown as SupabaseClient;
}

const chargeNotice = (over: Record<string, unknown> = {}) => ({
  senderUserId: "owner-1",
  senderEmail: "owner@axis.test",
  fromName: "PropLane Portal",
  senderRole: "admin" as const,
  subject: "New charge",
  text: "A new $25.00 charge was added.",
  toUserIds: ["res-1"],
  deliverToPortalInbox: false,
  deliverViaEmail: false,
  deliverViaSms: true,
  ownerManagerUserId: "owner-1",
  propertyId: "prop-1",
  ...over,
});

beforeEach(() => {
  h.sends = [];
  h.line = { phoneNumber: "+12065550199", numberId: "num-service" };
  h.lineError = false;
  h.workspaceId = "ws-managed";
  h.senderFrom = "";
});

describe("resolvePropertySendPin", () => {
  it("reads the house's own workspace and the line through the existing resolver", async () => {
    expect(await resolvePropertySendPin(fakeDb(), { ownerUserId: "owner-1", propertyId: "prop-1" })).toEqual({
      kind: "pinned",
      propertyId: "prop-1",
      workspaceId: "ws-managed",
      line: { phoneNumber: "+12065550199", numberId: "num-service" },
    });
  });

  it("no house, or a house with no workspace, pins nothing; an unreadable line is `unreadable` (never a fallback)", async () => {
    expect(await resolvePropertySendPin(fakeDb(), { ownerUserId: "owner-1", propertyId: null })).toEqual({ kind: "none" });
    h.workspaceId = null;
    expect(await resolvePropertySendPin(fakeDb(), { ownerUserId: "owner-1", propertyId: "prop-1" })).toEqual({ kind: "none" });
    h.workspaceId = "ws-managed";
    h.lineError = true;
    expect(await resolvePropertySendPin(fakeDb(), { ownerUserId: "owner-1", propertyId: "prop-1" })).toEqual({ kind: "unreadable" });
  });
});

describe("a charge text about a PropLane-managed house", () => {
  it("leaves from the house's line: property, workspace, actor, recipient and the pinned line reach the transport", async () => {
    const result = await deliverPortalInboxMessage(fakeDb(), chargeNotice());
    expect(result).toMatchObject({ ok: true });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      fromNumber: "+12065550199",
      propertyId: "prop-1",
      workspaceId: "ws-managed",
      actorUserId: "owner-1",
      selectedWorkLineId: "num-service",
      recipientUserId: "res-1",
      openThread: { managerUserId: "owner-1" },
    });
  });

  it("sends even when the sender's cached number is blank, because the line comes from the workspace", async () => {
    await deliverPortalInboxMessage(fakeDb(), chargeNotice());
    expect(h.sends).toHaveLength(1);
  });

  it("an unreadable line is reported failed and nothing is sent from another line", async () => {
    h.lineError = true;
    const result = await deliverPortalInboxMessage(fakeDb(), chargeNotice());
    expect(h.sends).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, smsOutcomes: [{ recipientEmail: "res1@axis.test", status: "failed" }] });
  });

  it("a message about no house is unchanged: no pin at all", async () => {
    // The sender has a cached number here, so the old path still sends.
    h.senderFrom = "+12065550111";
    await deliverPortalInboxMessage(fakeDb(), chargeNotice({ propertyId: undefined }));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({ fromNumber: "+12065550111" });
    for (const send of h.sends) {
      for (const key of ["propertyId", "workspaceId", "actorUserId", "selectedWorkLineId", "recipientUserId"]) expect(send).not.toHaveProperty(key);
    }
  });
});
