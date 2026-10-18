import { describe, expect, it } from "vitest";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { complaintThresholdCrossed, maskPhoneTail } from "@/lib/automations/escalations";
import { listEscalations, recordEscalationItem, recordHouseComplaint, resolveEscalation } from "@/lib/automations/escalations.server";

const houses = [
  { id: "P1", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "5259 Brooklyn" } },
  { id: "P2", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "4709A 8th Ave" } },
];

function seed() {
  return {
    manager_property_records: houses,
    sms_escalated_questions: [
      { id: "e1", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550100", role: "resident", property_id: "P1", topic: "other", question: "Can I have a cat?", source: "agent", excerpt: null, escalated_at: "2026-11-01T10:00:00Z", resolved_at: null },
      { id: "e2", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550111", role: "resident", property_id: "P2", topic: "repeated_complaints", question: "3 complaints in 30 days at this house", source: "ra", excerpt: "Loud music again", escalated_at: "2026-11-01T11:00:00Z", resolved_at: null },
      { id: "e3", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550122", role: "applicant", property_id: "P1", topic: "other", question: "Is parking free?", source: "unanswered", excerpt: null, escalated_at: "2026-10-30T10:00:00Z", resolved_at: "2026-10-31T10:00:00Z" },
      { id: "e4", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550133", role: "resident", property_id: "P1", topic: "complaint", question: "noise", source: "ra", escalated_at: "2026-11-01T09:00:00Z", resolved_at: "2026-11-01T09:00:00Z" },
      { id: "x1", workspace_id: "OTHER", owner_user_id: "stranger", phone_key: "2065550199", role: "resident", property_id: null, topic: "other", question: "Not yours", source: "agent", escalated_at: "2026-11-01T10:00:00Z", resolved_at: null },
    ],
  };
}

describe("pure rules", () => {
  it("crosses the threshold at the number and never without one", () => {
    expect(complaintThresholdCrossed(2, 3)).toBe(false);
    expect(complaintThresholdCrossed(3, 3)).toBe(true);
    expect(complaintThresholdCrossed(9, null)).toBe(false);
  });
  it("masks a number to its last four", () => {
    expect(maskPhoneTail("2065550100")).toBe("0100");
    expect(maskPhoneTail("12")).toBe("");
  });
});

describe("listEscalations", () => {
  it("lists the workspace's open items, newest first, with the house name and a masked number", async () => {
    const f = automationsFakeDb(seed());
    const items = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: null });
    expect(items.map((i) => i.id)).toEqual(["e2", "e1"]);
    expect(items[0]).toMatchObject({ source: "ra", houseLabel: "4709A 8th Ave", excerpt: "Loud music again", phoneTail: "0111" });
    expect(items[1]).toMatchObject({ source: "agent", houseLabel: "5259 Brooklyn", excerpt: "Can I have a cat?", topic: "" });
    expect(JSON.stringify(items)).not.toContain("2065550100");
  });

  it("never lists another workspace's items, or a logged complaint below the threshold", async () => {
    const f = automationsFakeDb(seed());
    const open = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: null });
    const resolved = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "resolved", allowedPropertyIds: null });
    expect([...open, ...resolved].map((i) => i.id)).not.toContain("x1");
    expect([...open, ...resolved].map((i) => i.id)).not.toContain("e4");
    expect(resolved.map((i) => i.id)).toEqual(["e3"]);
  });

  it("shows a co-manager only the houses they hold", async () => {
    const f = automationsFakeDb(seed());
    const items = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: ["P1"] });
    expect(items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("answers an empty list before the migration", async () => {
    const f = automationsFakeDb(seed(), { broken: ["sms_escalated_questions"] });
    expect(await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: null })).toEqual([]);
  });
});

describe("resolveEscalation", () => {
  it("resolves and reopens inside the workspace", async () => {
    const f = automationsFakeDb(seed());
    expect(await resolveEscalation(f.db, { workspaceId: "ws", id: "e1", userId: "mgr", allowedPropertyIds: null })).toBe(true);
    const row = f.rows.sms_escalated_questions!.find((r) => r.id === "e1")!;
    expect(row.resolved_by).toBe("mgr");
    expect(row.resolved_at).toBeTruthy();
    expect(await resolveEscalation(f.db, { workspaceId: "ws", id: "e1", userId: "mgr", allowedPropertyIds: null, reopen: true })).toBe(true);
    expect(f.rows.sms_escalated_questions!.find((r) => r.id === "e1")!.resolved_at).toBeNull();
  });

  it("cannot resolve another workspace's item, or a house a co-manager does not hold", async () => {
    const f = automationsFakeDb(seed());
    expect(await resolveEscalation(f.db, { workspaceId: "ws", id: "x1", userId: "mgr", allowedPropertyIds: null })).toBe(false);
    expect(await resolveEscalation(f.db, { workspaceId: "ws", id: "e2", userId: "mgr", allowedPropertyIds: ["P1"] })).toBe(false);
    expect(f.rows.sms_escalated_questions!.find((r) => r.id === "x1")!.resolved_at).toBeNull();
  });
});

describe("recordEscalationItem", () => {
  it("redacts card and bank numbers before storing", async () => {
    const f = automationsFakeDb();
    const id = await recordEscalationItem(f.db, {
      workspaceId: "ws", ownerUserId: "owner", source: "unanswered", phone: "(206) 555-0100",
      question: "My card 4242 4242 4242 4242 was charged", excerpt: "card 4242 4242 4242 4242",
    });
    expect(id).toBeTruthy();
    const row = f.rows.sms_escalated_questions![0]!;
    expect(String(row.question)).not.toContain("4242 4242");
    expect(String(row.excerpt)).not.toContain("4242 4242");
    expect(row.phone_key).toBe("2065550100");
    expect(row.source).toBe("unanswered");
  });
});

describe("recordHouseComplaint", () => {
  const info = setHouseInfoValue(emptyHouseInfo(), "rules", "escalateAfter", "3");
  const input = (houseInfo = info) => ({ workspaceId: "ws", ownerUserId: "owner", propertyId: "P1", phone: "2065550100", text: "Loud music again", houseInfo, now: new Date("2026-11-05T12:00:00Z") });

  it("logs quietly under the threshold: nothing reaches the inbox", async () => {
    const f = automationsFakeDb(seed());
    const out = await recordHouseComplaint(f.db, input());
    expect(out).toMatchObject({ logged: true, count: 2, threshold: 3, escalated: false });
    const open = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: ["P1"] });
    expect(open.map((i) => i.topic)).not.toContain("repeated_complaints");
  });

  it("files one repeated-complaints item when the count reaches the manager's number, and not another", async () => {
    const f = automationsFakeDb(seed());
    await recordHouseComplaint(f.db, input());
    const third = await recordHouseComplaint(f.db, input());
    expect(third).toMatchObject({ count: 3, escalated: true });
    const fourth = await recordHouseComplaint(f.db, input());
    expect(fourth).toMatchObject({ count: 4, escalated: false });
    const open = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: ["P1"] });
    const repeated = open.filter((i) => i.topic === "repeated_complaints");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ source: "ra", excerpt: "Loud music again" });
  });

  it("never escalates on count alone when the house sets no number", async () => {
    const f = automationsFakeDb(seed());
    for (let i = 0; i < 5; i += 1) await recordHouseComplaint(f.db, input(emptyHouseInfo()));
    const open = await listEscalations(f.db, { ownerUserId: "owner", workspaceId: "ws", status: "open", allowedPropertyIds: ["P1"] });
    expect(open.map((i) => i.topic)).not.toContain("repeated_complaints");
  });
});
