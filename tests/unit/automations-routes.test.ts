import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { emptyHouseInfo } from "@/lib/house-info";

const h = vi.hoisted(() => ({ actor: null as unknown, send: vi.fn(), post: vi.fn(), ready: vi.fn() }));
vi.mock("@/lib/one-number/knowledge/route-auth.server", () => ({
  requireKnowledgeActor: async () =>
    h.actor ? { ok: true, actor: h.actor } : { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) },
}));
vi.mock("@/lib/automations/send.server", () => ({ sendResidentAutomationText: h.send }));
vi.mock("@/lib/house-groups/post.server", () => ({ postToHouseGroup: h.post }));
vi.mock("@/lib/house-groups/ready.server", () => ({ houseGroupReady: h.ready }));
vi.mock("@/lib/automations/sources.server", () => ({
  loadHouseDirectory: async (_db: unknown, ids: string[]) =>
    new Map(ids.filter((id) => id === "P1" || id === "P2").map((id) => [id, { ownerUserId: "owner", workspaceId: "ws", propertyId: id, propertyLabel: id === "P1" ? "5259 Brooklyn" : "4709A 8th Ave", houseInfo: emptyHouseInfo() }])),
  loadLeaseSubjects: async () => [
    { leaseId: "L1", ownerUserId: "owner", workspaceId: "ws", propertyId: "P1", propertyLabel: "5259 Brooklyn", roomLabel: "Room 3", residentName: "Maya Chen", firstName: "Maya", residentUserId: "u1", residentEmail: "m@x.com", phoneKey: "2065550100", signedKey: "2026-10-18", moveIn: "2026-11-01", moveOut: null },
  ],
}));

import { GET as getAutomations, PUT as putAutomation } from "@/app/api/portal/automations/route";
import { POST as postPreview } from "@/app/api/portal/automations/preview/route";
import { POST as postRun } from "@/app/api/portal/automations/runs/[id]/route";
import { POST as postAnnounce } from "@/app/api/portal/automations/announce/route";
import { GET as getEscalations, PATCH as patchEscalation } from "@/app/api/portal/one-number/escalations/route";

const houses = [
  { id: "P1", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "5259 Brooklyn" } },
  { id: "P2", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "4709A 8th Ave" } },
];
const json = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (body: unknown) => new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup(opts: { owner?: boolean; allowed?: string[] | null; rows?: Record<string, Record<string, unknown>[]> } = {}) {
  const fake = automationsFakeDb({ manager_property_records: houses, ...opts.rows });
  h.actor = {
    userId: opts.owner === false ? "co" : "owner", db: fake.db, workspaceId: "ws", ownerUserId: "owner",
    isOwner: opts.owner !== false, allowedPropertyIds: opts.owner === false ? (opts.allowed ?? ["P1"]) : null,
  };
  return fake;
}

beforeEach(() => {
  h.actor = null;
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.post.mockReset().mockResolvedValue({ ok: true, messageSid: "SM" });
  h.ready.mockReset().mockResolvedValue(false);
});

describe("automations routes need a signed-in manager", () => {
  it("answers 401 everywhere", async () => {
    expect((await getAutomations()).status).toBe(401);
    expect((await putAutomation(put({ preset: "welcome", mode: "auto" }))).status).toBe(401);
    expect((await postPreview(json({ preset: "welcome" }))).status).toBe(401);
    expect((await postAnnounce(json({ text: "x", houseIds: "all" }))).status).toBe(401);
    expect((await getEscalations(new Request("http://x"))).status).toBe(401);
    expect((await patchEscalation(patch({ id: "e", action: "resolve" }))).status).toBe(401);
  });
});

describe("GET /api/portal/automations", () => {
  it("lists the twelve visible presets at their defaults with the variables a group text may use", async () => {
    setup();
    const body = await (await getAutomations()).json();
    expect(body.presets.map((p: { id: string }) => p.id)).toHaveLength(12);
    expect(body.presets.find((p: { id: string }) => p.id === "arrival_guide")).toMatchObject({ mode: "auto" });
    const welcome = body.presets.find((p: { id: string }) => p.id === "welcome");
    expect(welcome).toMatchObject({ mode: "draft", audience: "resident", isDefaultTemplate: true });
    const group = body.presets.find((p: { id: string }) => p.id === "rent_due_day");
    expect(group.variables.map((v: { id: string }) => v.id)).toEqual(["house"]);
    expect(body.houses.map((x: { id: string }) => x.id).sort()).toEqual(["P1", "P2"]);
    expect(body.canEdit).toBe(true);
  });

  it("hides held drafts on houses a co-manager does not hold", async () => {
    setup({
      owner: false,
      rows: {
        workspace_automation_runs: [
          { id: "r1", workspace_id: "ws", preset: "rent_due_day", audience: "group", status: "held", property_id: "P1", body: "a", created_at: "2026-11-01T00:00:00Z" },
          { id: "r2", workspace_id: "ws", preset: "rent_due_day", audience: "group", status: "held", property_id: "P2", body: "b", created_at: "2026-11-01T00:00:00Z" },
          { id: "r3", workspace_id: "other", preset: "rent_due_day", audience: "group", status: "held", property_id: "P1", body: "c", created_at: "2026-11-01T00:00:00Z" },
        ],
      },
    });
    const body = await (await getAutomations()).json();
    expect(body.canEdit).toBe(false);
    expect(body.held.map((r: { id: string }) => r.id)).toEqual(["r1"]);
    expect(body.houses.map((x: { id: string }) => x.id)).toEqual(["P1"]);
  });
});

describe("PUT /api/portal/automations", () => {
  it("saves a mode for the owner; the first pick opts the workspace in", async () => {
    const fake = setup();
    const res = await putAutomation(put({ preset: "welcome", mode: "auto" }));
    expect(res.status).toBe(200);
    expect(fake.rows.workspace_automation_presets).toHaveLength(1);
    expect(fake.rows.workspace_automation_presets![0]).toMatchObject({ workspace_id: "ws", preset: "welcome", mode: "auto", updated_by: "owner" });
  });

  it("is owner only", async () => {
    const fake = setup({ owner: false });
    expect((await putAutomation(put({ preset: "welcome", mode: "auto" }))).status).toBe(403);
    expect(fake.rows.workspace_automation_presets ?? []).toHaveLength(0);
  });

  it("refuses a mode the preset does not offer, an unknown preset and bad wording", async () => {
    setup();
    expect((await putAutomation(put({ preset: "rent_due_3d", mode: "draft" }))).status).toBe(400);
    expect((await putAutomation(put({ preset: "nope", mode: "auto" }))).status).toBe(400);
    expect((await putAutomation(put({ preset: "rent_due_day", template: "Hi {first_name}, pay {amount}" }))).status).toBe(400);
    expect((await putAutomation(put({ preset: "rent_due_3d", template: "Pay up" }))).status).toBe(400);
    expect((await putAutomation(put({ preset: "welcome", mode: "bogus" }))).status).toBe(400);
  });

  it("answers 503 with the error code when the write fails, never a silent 200", async () => {
    setup();
    const broken = automationsFakeDb({ manager_property_records: houses }, { broken: ["workspace_automation_presets"] });
    (h.actor as { db: unknown }).db = broken.db;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await putAutomation(put({ preset: "welcome", mode: "auto" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Could not save.", code: "42P01" });
    expect(broken.rows.workspace_automation_presets ?? []).toHaveLength(0);
    spy.mockRestore();
  });

  it("saves wording, and returns to the default when it is saved unchanged", async () => {
    const fake = setup();
    await putAutomation(put({ preset: "welcome", template: "Hey {first_name}, welcome to {house}!" }));
    expect(fake.rows.workspace_automation_presets![0]).toMatchObject({ template: "Hey {first_name}, welcome to {house}!", mode: "draft" });
    await putAutomation(put({ preset: "welcome", template: null }));
    expect(fake.rows.workspace_automation_presets![0]!.template).toBeNull();
  });
});

describe("POST /api/portal/automations/preview", () => {
  it("fills the preset from a real resident and shows the manager's wording as typed", async () => {
    setup();
    const body = await (await postPreview(json({ preset: "welcome", template: "Hi {first_name}, {house} on {move_in_date}" }))).json();
    expect(body).toMatchObject({ text: "Hi Maya, 5259 Brooklyn on Nov 1", usedRealData: true });
  });
  it("refuses wording the preset cannot send", async () => {
    setup();
    expect((await postPreview(json({ preset: "rent_due_day", template: "Pay {pay_link}" }))).status).toBe(400);
  });
});

describe("POST /api/portal/automations/runs/[id]", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const held = (over: Record<string, unknown> = {}) => ({
    id: "r1", workspace_id: "ws", owner_user_id: "owner", preset: "welcome", audience: "resident", status: "held", mode: "draft",
    property_id: null, phone_key: "2065550100", body: "Welcome, Maya!", idempotency_key: "welcome:L1", created_at: "2026-11-01T00:00:00Z", ...over,
  });

  it("sends a held draft in the actor's workspace", async () => {
    const fake = setup({ rows: { workspace_automation_runs: [held()] } });
    const res = await postRun(json({ action: "send" }), ctx("r1"));
    expect(res.status).toBe(200);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(fake.rows.workspace_automation_runs![0]!.status).toBe("sent");
  });

  it("will not touch another workspace's draft, or a house a co-manager does not hold", async () => {
    setup({ rows: { workspace_automation_runs: [held({ id: "r9", workspace_id: "other" })] } });
    expect((await postRun(json({ action: "send" }), ctx("r9"))).status).toBe(404);
    setup({ owner: false, allowed: ["P1"], rows: { workspace_automation_runs: [held({ audience: "group", property_id: "P2", preset: "rent_due_day" })] } });
    expect((await postRun(json({ action: "send" }), ctx("r1"))).status).toBe(404);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("dismisses, and refuses an unknown action", async () => {
    const fake = setup({ rows: { workspace_automation_runs: [held()] } });
    expect((await postRun(json({ action: "explode" }), ctx("r1"))).status).toBe(400);
    expect((await postRun(json({ action: "dismiss" }), ctx("r1"))).status).toBe(200);
    expect(fake.rows.workspace_automation_runs![0]!.status).toBe("dismissed");
    expect((await postRun(json({ action: "dismiss" }), ctx("r1"))).status).toBe(409);
  });
});

describe("POST /api/portal/automations/announce", () => {
  const optIn = { workspace_automation_presets: [{ workspace_id: "ws", preset: "announcement", mode: "auto" }] };

  it("sends to the chosen house only, one on one when it has no group", async () => {
    setup({ rows: optIn });
    const res = await postAnnounce(json({ text: "Water is off Tuesday 9-12.", houseIds: ["P1"], announcementId: "A1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.houses.map((x: { propertyId: string; outcome: string }) => [x.propertyId, x.outcome])).toEqual([["P1", "sent"]]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1].text).toBe("Water is off Tuesday 9-12.");
  });

  it("ignores a house id that is not the actor's and asks which house", async () => {
    setup({ rows: optIn });
    const res = await postAnnounce(json({ text: "Water is off.", houseIds: ["P-other"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).houses.map((x: { id: string }) => x.id).sort()).toEqual(["P1", "P2"]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a co-manager can announce only to their own houses, even with 'all'", async () => {
    setup({ owner: false, allowed: ["P1"], rows: optIn });
    const body = await (await postAnnounce(json({ text: "Water is off.", houseIds: "all", announcementId: "A2" }))).json();
    expect(body.houses.map((x: { propertyId: string }) => x.propertyId)).toEqual(["P1"]);
  });

  it("refuses an empty announcement, and one that names a resident", async () => {
    setup({ rows: optIn });
    expect((await postAnnounce(json({ text: "  ", houseIds: "all" }))).status).toBe(400);
    const body = await (await postAnnounce(json({ text: "Maya please move your bike", houseIds: ["P1"], announcementId: "A3" }))).json();
    expect(body.houses[0]).toMatchObject({ outcome: "skipped" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("repeating the same announcement id sends nothing the second time", async () => {
    setup({ rows: optIn });
    await postAnnounce(json({ text: "Cleaning Friday.", houseIds: ["P1"], announcementId: "A4" }));
    const second = await (await postAnnounce(json({ text: "Cleaning Friday.", houseIds: ["P1"], announcementId: "A4" }))).json();
    expect(second.houses[0].outcome).toBe("duplicate");
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe("escalations routes", () => {
  const rows = {
    sms_escalated_questions: [
      { id: "e1", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550100", role: "resident", property_id: "P1", topic: "other", question: "Cat?", source: "agent", escalated_at: "2026-11-01T10:00:00Z", resolved_at: null },
      { id: "e2", workspace_id: "ws", owner_user_id: "owner", phone_key: "2065550111", role: "resident", property_id: "P2", topic: "other", question: "Pool?", source: "agent", escalated_at: "2026-11-01T11:00:00Z", resolved_at: null },
      { id: "x1", workspace_id: "other", owner_user_id: "z", phone_key: "2065550122", role: "resident", property_id: null, topic: "other", question: "Not yours", source: "agent", escalated_at: "2026-11-01T11:00:00Z", resolved_at: null },
    ],
  };
  it("lists the workspace's open items only", async () => {
    setup({ rows });
    const body = await (await getEscalations(new Request("http://x?status=open"))).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["e2", "e1"]);
  });
  it("a co-manager sees and resolves only their houses", async () => {
    const fake = setup({ owner: false, allowed: ["P1"], rows });
    expect((await (await getEscalations(new Request("http://x"))).json()).items.map((i: { id: string }) => i.id)).toEqual(["e1"]);
    expect((await patchEscalation(patch({ id: "e2", action: "resolve" }))).status).toBe(404);
    expect((await patchEscalation(patch({ id: "x1", action: "resolve" }))).status).toBe(404);
    expect((await patchEscalation(patch({ id: "e1", action: "resolve" }))).status).toBe(200);
    expect(fake.rows.sms_escalated_questions!.find((r) => r.id === "e1")!.resolved_by).toBe("co");
  });
  it("refuses a malformed request", async () => {
    setup({ rows });
    expect((await patchEscalation(patch({ id: "e1", action: "delete" }))).status).toBe(400);
    expect((await patchEscalation(patch({}))).status).toBe(400);
  });
});
