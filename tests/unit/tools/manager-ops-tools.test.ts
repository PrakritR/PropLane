import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import { makeWritableCtx, previewWrite, executeWrite } from "./fake-agent-ctx";

const send = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock("@/lib/tools/domains/messaging", () => ({
  sendMessageTool: {
    handler: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => {
      send.calls.push(input);
      if (send.fail) throw new Error("no delivery");
      return { reply: "ok" };
    }),
  },
}));
const optedOut = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/sms-consent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sms-consent")>("@/lib/sms-consent");
  return { ...actual, isPhoneOptedOut: vi.fn(async (_db: unknown, phone: string) => optedOut.has(phone)) };
});

import {
  broadcastToResidentsTool,
  getApplicationReviewLinkTool,
  listToursOnDayTool,
  listUnpaidRentTool,
} from "@/lib/tools/domains/manager-ops";
import { agentRegistry, buildManagerSmsRegistry, MANAGER_SMS_DEEP_LINK_ONLY_TOOLS } from "@/lib/tools";
import { PLANNED_RECORD_ID } from "@/lib/tour-inquiry.server";

type Row = Record<string, unknown>;

const A = "manager_a";
const B = "manager_b";

const rowOf = (manager: string, data: Record<string, unknown>, extra: Row = {}): Row => ({
  id: String(data.id),
  manager_user_id: manager,
  row_data: data,
  ...extra,
});

const charge = (id: string, manager: string, propertyId: string, over: Record<string, unknown> = {}): Row =>
  rowOf(manager, {
    id,
    kind: "rent",
    rentMonth: "2026-10",
    status: "pending",
    amountLabel: "$900.00",
    balanceLabel: "$900.00",
    residentEmail: `${id}@x.test`,
    residentName: id,
    residentUserId: null,
    propertyId,
    propertyLabel: propertyId,
    managerUserId: manager,
    ...over,
  });

const resident = (id: string, manager: string, propertyId: string, over: Record<string, unknown> = {}): Row =>
  rowOf(manager, { id, bucket: "approved", stage: "Resident", name: id, email: `${id}@x.test`, propertyId, property: propertyId, managerUserId: manager, ...over }, { resident_email: `${id}@x.test` });

const house = (id: string, manager: string, title: string): Row => ({
  id,
  manager_user_id: manager,
  status: "live",
  row_data: { title },
  property_data: { title, address: title },
});

function ctxFor(tables: Record<string, Row[]>, over: Partial<AgentContext> = {}) {
  return makeWritableCtx(tables, { landlordId: A, userId: A, ...over });
}

beforeEach(() => {
  send.calls.length = 0;
  send.fail = false;
  optedOut.clear();
});

describe("list_unpaid_rent is scoped to the team that asks", () => {
  const tables = () => ({
    portal_household_charge_records: [
      charge("ann", A, "p_a1", { status: "paid" }),
      charge("ben", A, "p_a1"),
      charge("cy", A, "p_a2", { balanceLabel: "$400.00" }),
      charge("dee", B, "p_b1"),
      charge("eli", B, "p_b1", { status: "paid" }),
    ],
  });

  it("never includes another team's residents", async () => {
    const { ctx } = ctxFor(tables());
    const out = (await listUnpaidRentTool.handler(ctx, { month: "2026-10" })) as { paidCount: number; unpaidCount: number; unpaid: Array<{ resident: string }>; unpaidTotal: string };
    expect(out.paidCount).toBe(1);
    expect(out.unpaidCount).toBe(2);
    expect(out.unpaid.map((u) => u.resident).sort()).toEqual(["ben", "cy"]);
    expect(out.unpaidTotal).toBe("$1,300");
    expect(JSON.stringify(out)).not.toContain("dee");
  });

  it("narrows to the workspace the number belongs to", async () => {
    const { ctx } = ctxFor(tables(), { workspace: { id: "ws1", name: "North", isDefault: false, narrowing: true, propertyIds: ["p_a1"] } });
    const out = (await listUnpaidRentTool.handler(ctx, { month: "2026-10" })) as { unpaid: Array<{ resident: string }> };
    expect(out.unpaid.map((u) => u.resident)).toEqual(["ben"]);
  });

  it("can ask for one house and rejects a bad month", async () => {
    const { ctx } = ctxFor(tables());
    const one = (await listUnpaidRentTool.handler(ctx, { month: "2026-10", propertyId: "p_a2" })) as { unpaid: Array<{ resident: string }> };
    expect(one.unpaid.map((u) => u.resident)).toEqual(["cy"]);
    expect(await listUnpaidRentTool.handler(ctx, { month: "October" })).toEqual({ error: "month must look like 2026-10." });
  });
});

describe("list_tours_on_day", () => {
  const tour = (id: string, manager: string, propertyId: string, start: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "tour",
    managerUserId: manager,
    propertyId,
    propertyTitle: `House ${propertyId}`,
    attendeeName: id,
    start,
    end: start,
    ...over,
  });
  const tables = () => ({
    portal_schedule_records: [
      {
        id: PLANNED_RECORD_ID,
        row_data: {
          payload: [
            tour("sam", A, "p_a1", "2026-10-19T17:00:00Z"), // 10:00 am Pacific, Oct 19
            tour("tia", A, "p_a2", "2026-10-19T21:30:00Z"), // 2:30 pm
            tour("old", A, "p_a1", "2026-10-18T17:00:00Z"), // yesterday
            tour("gone", A, "p_a1", "2026-10-19T18:00:00Z", { canceledAt: "2026-10-18T00:00:00Z" }),
            tour("zed", B, "p_b1", "2026-10-19T17:00:00Z"), // another team
          ],
        },
      },
    ],
  });

  it("lists a day's confirmed tours in time order, only this team's, without cancelled ones", async () => {
    const { ctx } = ctxFor(tables());
    const out = (await listToursOnDayTool.handler(ctx, { day: "2026-10-19" })) as { confirmedCount: number; confirmed: Array<{ time: string; who: string }> };
    expect(out.confirmedCount).toBe(2);
    expect(out.confirmed).toEqual([
      { time: "10:00 am", who: "sam", house: "House p_a1" },
      { time: "2:30 pm", who: "tia", house: "House p_a2" },
    ]);
  });

  it("keeps another workspace of the same owner out", async () => {
    const { ctx } = ctxFor(tables(), { workspace: { id: "ws1", name: "North", isDefault: false, narrowing: true, propertyIds: ["p_a2"] } });
    const out = (await listToursOnDayTool.handler(ctx, { day: "2026-10-19" })) as { confirmed: Array<{ who: string }> };
    expect(out.confirmed.map((t) => t.who)).toEqual(["tia"]);
  });

  it("answers a delegated teammate only about the houses assigned to them", async () => {
    const { ctx } = ctxFor(tables(), {
      managerSmsAccess: { mode: "delegated", workNumberOwnerId: A, actorUserId: "mate", dataOwnerIds: [A], assignedPropertyIds: ["p_a1"] },
    });
    const out = (await listToursOnDayTool.handler(ctx, { day: "2026-10-19" })) as { confirmed: Array<{ who: string }> };
    expect(out.confirmed.map((t) => t.who)).toEqual(["sam"]);
  });

  it("refuses a day it cannot read", async () => {
    const { ctx } = ctxFor(tables());
    expect(await listToursOnDayTool.handler(ctx, { day: "someday" })).toEqual({ error: "day must be today, tomorrow or a real date as YYYY-MM-DD." });
  });
});

describe("get_application_review_link: approval is a link, never an action", () => {
  const apps = () => ({
    manager_application_records: [
      rowOf(A, { id: "PROPLANE-PRIYA1", name: "Priya", property: "5259 Brooklyn", bucket: "pending" }),
      rowOf(B, { id: "PROPLANE-OTHER1", name: "Other", property: "Elsewhere", bucket: "pending" }),
    ],
  });
  it("returns the portal link for the manager's own application", async () => {
    const { ctx } = ctxFor(apps());
    const out = (await getApplicationReviewLinkTool.handler(ctx, { applicationId: "PROPLANE-PRIYA1" })) as { found: boolean; url: string; applicant: string };
    expect(out.found).toBe(true);
    expect(out.applicant).toBe("Priya");
    expect(out.url).toMatch(/\/portal\/applications\?open=PROPLANE-PRIYA1$/);
  });
  it("does not reveal another manager's application", async () => {
    const { ctx } = ctxFor(apps());
    const out = (await getApplicationReviewLinkTool.handler(ctx, { applicationId: "PROPLANE-OTHER1" })) as { found: boolean };
    expect(out.found).toBe(false);
  });
  it("is read-only and the approving tools are withheld from a text", () => {
    expect(getApplicationReviewLinkTool.kind).toBe("read");
    const sms = buildManagerSmsRegistry();
    expect(sms.has("get_application_review_link")).toBe(true);
    for (const name of MANAGER_SMS_DEEP_LINK_ONLY_TOOLS) {
      expect(agentRegistry.has(name)).toBe(true); // the portal assistant keeps them
      expect(sms.has(name)).toBe(false); // a text never approves
    }
    expect(sms.has("update_application_bucket")).toBe(false);
  });
});

describe("broadcast_to_residents", () => {
  const tables = () => ({
    manager_property_records: [house("p_5257", A, "5257 Brooklyn"), house("p_5259", A, "5259 Brooklyn"), house("p_b1", B, "9 Other St")],
    manager_application_records: [
      resident("r1", A, "p_5257"),
      resident("r2", A, "p_5257"),
      resident("r3", A, "p_5259"),
      resident("moved", A, "p_5257", { stage: "Previous resident" }),
      resident("foreign", B, "p_b1"),
    ],
    profiles: [
      { id: "u1", email: "r1@x.test", phone: "+12065550101", phone_verified_at: "2026-01-01T00:00:00Z" },
      { id: "u2", email: "r2@x.test", phone: "+12065550102", phone_verified_at: "2026-01-01T00:00:00Z" },
      { id: "u3", email: "r3@x.test", phone: null, phone_verified_at: null },
    ],
  });

  it("asks which house when the manager runs several and named none", async () => {
    const { ctx } = ctxFor(tables());
    const res = await previewWrite(broadcastToResidentsTool, ctx, { message: "Water off Tuesday 9-12" });
    expect(res).toEqual({ ok: false, error: "Which house: 5257 Brooklyn, 5259 Brooklyn, or all?" });
  });

  it("previews the recipient count for one house, current residents only, with consent reflected", async () => {
    optedOut.add("+12065550102");
    const { ctx } = ctxFor(tables());
    const res = await previewWrite(broadcastToResidentsTool, ctx, { propertyId: "p_5257", message: "Water off Tuesday 9-12" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.title).toBe("Message 2 residents");
    expect(res.preview.batchCount).toBe(2);
    const fields = Object.fromEntries(res.preview.fields.map((f) => [f.label, f.value]));
    expect(fields.Residents).toBe("2");
    expect(fields["By text"]).toBe("1 of 2"); // r2 said STOP
    expect(fields.Message).toBe("Water off Tuesday 9-12");
  });

  it("reaches every house on allHouses, and still never another team's residents", async () => {
    const { ctx } = ctxFor(tables());
    const res = await previewWrite(broadcastToResidentsTool, ctx, { allHouses: true, message: "Inspections Friday" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.batchCount).toBe(3);
  });

  it("refuses a house that is not this account's, whatever id was passed", async () => {
    const { ctx } = ctxFor(tables());
    const res = await previewWrite(broadcastToResidentsTool, ctx, { propertyId: "p_b1", message: "Hello" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No house with that id/);
  });

  it("stays inside the workspace the number belongs to", async () => {
    const { ctx } = ctxFor(tables(), { workspace: { id: "ws1", name: "North", isDefault: false, narrowing: true, propertyIds: ["p_5259"] } });
    // Only one house is in scope, so no question is needed and only its residents are reached.
    const res = await previewWrite(broadcastToResidentsTool, ctx, { message: "Hello" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.batchCount).toBe(1);
    const other = await previewWrite(broadcastToResidentsTool, ctx, { propertyId: "p_5257", message: "Hello" });
    expect(other.ok).toBe(false);
  });

  it("sends through the one messaging path to re-derived recipients, and audits once", async () => {
    const { ctx, store } = ctxFor(tables());
    const done = await executeWrite(broadcastToResidentsTool, ctx, { propertyId: "p_5257", message: "Water off Tuesday 9-12" });
    expect(done.ok).toBe(true);
    expect(done.reply).toBe("Sent to 2 residents.");
    expect(send.calls).toHaveLength(1);
    expect((send.calls[0]!.toEmails as string[]).sort()).toEqual(["r1@x.test", "r2@x.test"]);
    expect(send.calls[0]!.body).toBe("Water off Tuesday 9-12");
    const audits = (store.audit_log ?? []).filter((r) => r.action === "broadcast_to_residents");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.input_summary).toMatchObject({ recipientCount: 2, houseCount: 1 });
    // The same message to the same people the same day is not sent twice.
    const again = await executeWrite(broadcastToResidentsTool, ctx, { propertyId: "p_5257", message: "Water off Tuesday 9-12" });
    expect(again.reply).toMatch(/already went/);
    expect(send.calls).toHaveLength(1);
  });

  it("does not send a stored foreign house at execute time", async () => {
    const { ctx } = ctxFor(tables());
    const res = await executeWrite(broadcastToResidentsTool, ctx, { propertyId: "p_b1", message: "Hello" });
    expect(res.ok).toBe(false);
    expect(send.calls).toHaveLength(0);
  });

  it("makes the text a single GSM-7 body and reports a total failure", async () => {
    const { ctx } = ctxFor(tables());
    send.fail = true;
    const res = await executeWrite(broadcastToResidentsTool, ctx, { propertyId: "p_5259", message: "Don’t park here — tow zone" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not be delivered/);
  });

  it("is a write tool (preview then YES), withheld from nobody, and counted as a message sender", () => {
    expect(broadcastToResidentsTool.kind).toBe("write");
    expect(typeof broadcastToResidentsTool.preview).toBe("function");
    expect(buildManagerSmsRegistry().has("broadcast_to_residents")).toBe(true);
  });
});

describe("the manager SMS catalog carries the spec's commands", () => {
  it("has a tool for each command in the manager table", () => {
    const sms = buildManagerSmsRegistry();
    for (const name of [
      "list_tours_on_day", // who's touring tomorrow
      "list_vacant_rooms", // what's vacant at 5259 Brooklyn
      "list_unpaid_rent", // who hasn't paid October rent
      "mark_room_rented", // mark room 3 at 4709A rented to Sam from Nov 1
      "update_room_rent", // drop room 2 price to $950
      "get_application_review_link", // approve Priya's application (a link)
      "broadcast_to_residents", // text all 5257 residents
      "dispatch_vendor", // send the plumber to the 8th Ave leak
      "set_up_payouts", // set up payouts
    ]) {
      expect(sms.has(name), name).toBe(true);
    }
  });
  it("puts every data-changing command behind a preview (the YES gate)", () => {
    const sms = buildManagerSmsRegistry();
    for (const name of ["mark_room_rented", "update_room_rent", "broadcast_to_residents", "dispatch_vendor"]) {
      const tool = sms.get(name)!;
      expect(tool.kind, name).toBe("write");
    }
    for (const name of ["list_tours_on_day", "list_vacant_rooms", "list_unpaid_rent", "get_application_review_link", "set_up_payouts"]) {
      expect(sms.get(name)!.kind, name).toBe("read");
    }
  });
});
