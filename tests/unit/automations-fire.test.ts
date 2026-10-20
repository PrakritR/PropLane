import { beforeEach, describe, expect, it, vi } from "vitest";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import type { HouseSubject, LeaseSubject } from "@/lib/automations/moments";

const h = vi.hoisted(() => ({
  ready: vi.fn(),
  post: vi.fn(),
  send: vi.fn(),
  houses: new Map<string, unknown>(),
  leases: [] as unknown[],
}));

vi.mock("@/lib/house-groups/ready.server", () => ({ houseGroupReady: h.ready }));
vi.mock("@/lib/house-groups/post.server", () => ({ postToHouseGroup: h.post }));
vi.mock("@/lib/automations/send.server", () => ({ sendResidentAutomationText: h.send }));
vi.mock("@/lib/automations/sources.server", () => ({
  loadHouseDirectory: async () => h.houses,
  loadLeaseSubjects: async () => h.leases,
}));

import { approveHeldRun, dismissHeldRun, fireAutomation, reconcileHeldRuns } from "@/lib/automations/fire.server";

const lease = (over: Partial<LeaseSubject> = {}): LeaseSubject => ({
  leaseId: "L1",
  ownerUserId: "owner",
  workspaceId: "ws",
  propertyId: "P1",
  propertyLabel: "5259 Brooklyn",
  roomLabel: "Room 3",
  residentName: "Maya Chen",
  firstName: "Maya",
  residentUserId: "u1",
  residentEmail: "maya@example.com",
  phoneKey: "2065550100",
  signedKey: "2026-10-18",
  moveIn: "2026-11-01",
  moveOut: null,
  ...over,
});

let info = emptyHouseInfo();
info = setHouseInfoValue(info, "access", "doorCode", "4821");
const house: HouseSubject = { ownerUserId: "owner", workspaceId: "ws", propertyId: "P1", propertyLabel: "5259 Brooklyn", houseInfo: info };
const roster = [lease(), lease({ leaseId: "L2", firstName: "Jo", phoneKey: "2065550111", residentUserId: "u2" }), lease({ leaseId: "L3", firstName: "Sam", phoneKey: null, residentUserId: "u3" })];

const residentTarget = { kind: "resident" as const, phoneKey: "2065550100", residentUserId: "u1", residentEmail: "maya@example.com" };
const welcomeVars = { first_name: "Maya", house: "5259 Brooklyn", move_in_date: "Nov 1", guide_link: "https://proplane.ai/l/x" };

const settingsRow = (preset: string, mode: string, template: string | null = null) => ({ workspace_id: "ws", preset, mode, template });

beforeEach(() => {
  h.ready.mockReset().mockResolvedValue(true);
  h.post.mockReset().mockResolvedValue({ ok: true, messageSid: "SM1" });
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.houses = new Map([["P1", house]]);
  h.leases = roster;
});

const base = { workspaceId: "ws", ownerUserId: "owner" };

describe("fireAutomation: modes", () => {
  it("does nothing, and records nothing, when the preset is off", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "off")] });
    const out = await fireAutomation(f.db, { ...base, preset: "welcome", idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget });
    expect(out).toEqual({ status: "off" });
    expect(h.send).not.toHaveBeenCalled();
    expect(f.rows.workspace_automation_runs ?? []).toHaveLength(0);
  });

  it("holds a new preset as a draft in the resident's thread by default, and sends nothing", async () => {
    const f = automationsFakeDb();
    const out = await fireAutomation(f.db, { ...base, preset: "welcome", idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget });
    expect(out.status).toBe("held");
    expect(h.send).not.toHaveBeenCalled();
    const drafts = f.rows.sms_ai_reply_drafts ?? [];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ workspace_id: "ws", phone_key: "2065550100", role: "resident", mode: "draft", topic: "automation:welcome" });
    expect(String(drafts[0]!.body)).toContain("Welcome, Maya! You're moving into 5259 Brooklyn on Nov 1.");
    const runs = f.rows.workspace_automation_runs!;
    expect(runs[0]).toMatchObject({ status: "held", mode: "draft", audience: "resident", draft_id: drafts[0]!.id });
  });

  it("sends once in auto, and a repeat of the same moment sends nothing", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "auto")] });
    const req = { ...base, preset: "welcome" as const, idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget };
    expect((await fireAutomation(f.db, req)).status).toBe("sent");
    expect((await fireAutomation(f.db, req)).status).toBe("duplicate");
    expect((await fireAutomation(f.db, req)).status).toBe("duplicate");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1]).toMatchObject({ workspaceId: "ws", ownerUserId: "owner", phoneKey: "2065550100", idempotencyKey: "welcome:L1" });
    expect(f.rows.workspace_automation_runs![0]!.status).toBe("sent");
  });

  it("uses the manager's own wording when one is saved", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "auto", "Hey {first_name}, welcome to {house}!")] });
    await fireAutomation(f.db, { ...base, preset: "welcome", idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget });
    expect(h.send.mock.calls[0]![1].text).toBe("Hey Maya, welcome to 5259 Brooklyn!");
  });

  it("gives the moment back on a quiet-hours refusal so a later tick sends it", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "auto")] });
    h.send.mockResolvedValueOnce({ ok: false, retry: true, reason: "quiet_hours" });
    const req = { ...base, preset: "welcome" as const, idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget };
    expect(await fireAutomation(f.db, req)).toEqual({ status: "deferred", reason: "quiet_hours" });
    expect(f.rows.workspace_automation_runs ?? []).toHaveLength(0);
    expect((await fireAutomation(f.db, req)).status).toBe("sent");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("records an opt-out as skipped and never retries it", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "auto")] });
    h.send.mockResolvedValue({ ok: false, retry: false, reason: "opted_out" });
    const req = { ...base, preset: "welcome" as const, idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget };
    expect((await fireAutomation(f.db, req)).status).toBe("skipped");
    expect((await fireAutomation(f.db, req)).status).toBe("duplicate");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("refuses to send without the facts the text needs", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("welcome", "auto")] });
    const out = await fireAutomation(f.db, { ...base, preset: "welcome", idempotencyKey: "welcome:L1", vars: { ...welcomeVars, move_in_date: "" }, target: residentTarget });
    expect(out).toEqual({ status: "skipped", reason: "missing_facts" });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("fireAutomation: house groups", () => {
  const groupTarget = { kind: "group" as const, house, roster, fallbackToResidents: false };

  it("posts the rent-due reminder to the group with no name, no amount and no code", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("rent_due_day", "auto")] });
    const out = await fireAutomation(f.db, { ...base, preset: "rent_due_day", idempotencyKey: "rent_due_day:P1:2026-11-01", vars: { house: "5259 Brooklyn" }, target: groupTarget });
    expect(out.status).toBe("sent");
    expect(h.post).toHaveBeenCalledTimes(1);
    const [, posted] = h.post.mock.calls[0]!;
    expect(posted).toMatchObject({ workspaceId: "ws", propertyId: "P1", kind: "rent_due_day", idempotencyKey: "automation:rent_due_day:P1:2026-11-01" });
    expect(posted.text).toBe("Friendly reminder: rent is due today. Check your texts for your pay link.");
    expect(posted.text).not.toMatch(/\$|Maya|Jo\b|Sam|4821/);
  });

  it("holds a group preset for approval by default, and posts nothing yet", async () => {
    const f = automationsFakeDb();
    const out = await fireAutomation(f.db, { ...base, preset: "rent_due_day", idempotencyKey: "rent_due_day:P1:2026-11-01", vars: { house: "5259 Brooklyn" }, target: groupTarget });
    expect(out.status).toBe("held");
    expect(h.post).not.toHaveBeenCalled();
    expect(f.rows.sms_ai_reply_drafts ?? []).toHaveLength(0);
    expect(f.rows.workspace_automation_runs![0]).toMatchObject({ status: "held", audience: "group", property_id: "P1" });
  });

  it("is silent for a group-only preset when the house has no group: no draft, no record", async () => {
    h.ready.mockResolvedValue(false);
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("rent_due_day", "auto")] });
    const out = await fireAutomation(f.db, { ...base, preset: "rent_due_day", idempotencyKey: "k", vars: { house: "x" }, target: groupTarget });
    expect(out).toEqual({ status: "skipped", reason: "no_group" });
    expect(h.post).not.toHaveBeenCalled();
    expect(f.rows.workspace_automation_runs ?? []).toHaveLength(0);
  });

  it("refuses an announcement that names a resident, carries an amount, or leaks the door code", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("announcement", "auto")] });
    for (const [i, text] of ["Maya left the stove on", "Rent is $850 this month", "The door code is 4821"].entries()) {
      const out = await fireAutomation(f.db, { ...base, preset: "announcement", idempotencyKey: `a${i}`, vars: { house: "x", announcement: text }, target: { ...groupTarget, fallbackToResidents: true } });
      expect(out.status, text).toBe("skipped");
    }
    expect(h.post).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect((f.rows.workspace_automation_runs ?? []).map((r) => r.reason)).toEqual(["group_text:name", "group_text:money", "group_text:secret"]);
  });

  it("falls back to each resident with a phone when an announcement has no group", async () => {
    h.ready.mockResolvedValue(false);
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("announcement", "auto")] });
    const out = await fireAutomation(f.db, { ...base, preset: "announcement", idempotencyKey: "announce:A:P1", vars: { house: "x", announcement: "Water is off Tuesday 9-12." }, target: { ...groupTarget, fallbackToResidents: true } });
    expect(out.status).toBe("sent");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls.map((c) => c[1].phoneKey).sort()).toEqual(["2065550100", "2065550111"]);
    expect(h.send.mock.calls[0]![1].text).toBe("Water is off Tuesday 9-12.");
  });

  it("falls back when the group seam says it is not enabled", async () => {
    h.post.mockResolvedValue({ ok: false, reason: "not_enabled" });
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("announcement", "auto")] });
    const out = await fireAutomation(f.db, { ...base, preset: "announcement", idempotencyKey: "announce:B:P1", vars: { house: "x", announcement: "Cleaning day Friday." }, target: { ...groupTarget, fallbackToResidents: true } });
    expect(out.status).toBe("sent");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("retries a group post held back by quiet hours or a rate limit", async () => {
    h.post.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("move_in_day", "auto")] });
    const req = { ...base, preset: "move_in_day" as const, idempotencyKey: "move_in_day:P1:d", vars: { house: "x" }, target: groupTarget };
    expect((await fireAutomation(f.db, req)).status).toBe("deferred");
    expect((await fireAutomation(f.db, req)).status).toBe("sent");
  });
});

describe("approving and dismissing a held draft", () => {
  async function held() {
    const f = automationsFakeDb({ workspace_automation_presets: [] });
    await fireAutomation(f.db, { ...base, preset: "welcome", idempotencyKey: "welcome:L1", vars: welcomeVars, target: residentTarget });
    const run = f.rows.workspace_automation_runs![0]!;
    return { f, runId: String(run.id) };
  }

  it("sends the held text once on the first tap and refuses a second", async () => {
    const { f, runId } = await held();
    expect(await approveHeldRun(f.db, { workspaceId: "ws", runId })).toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1]).toMatchObject({ phoneKey: "2065550100", idempotencyKey: "welcome:L1" });
    expect(f.rows.workspace_automation_runs![0]!.status).toBe("sent");
    expect(f.rows.sms_ai_reply_drafts![0]!.status).toBe("sent");
    expect(await approveHeldRun(f.db, { workspaceId: "ws", runId })).toMatchObject({ ok: false, reason: "not_held" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("will not touch another workspace's draft", async () => {
    const { f, runId } = await held();
    expect(await approveHeldRun(f.db, { workspaceId: "other", runId })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await dismissHeldRun(f.db, { workspaceId: "other", runId })).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps the draft when texts are paused, so the manager can tap again later", async () => {
    const { f, runId } = await held();
    h.send.mockResolvedValueOnce({ ok: false, retry: true, reason: "quiet_hours" });
    expect(await approveHeldRun(f.db, { workspaceId: "ws", runId })).toMatchObject({ ok: false, reason: "retry_later" });
    expect(f.rows.workspace_automation_runs![0]!.status).toBe("held");
    expect(await approveHeldRun(f.db, { workspaceId: "ws", runId })).toEqual({ ok: true });
  });

  it("dismiss closes the run and rejects the thread draft", async () => {
    const { f, runId } = await held();
    expect(await dismissHeldRun(f.db, { workspaceId: "ws", runId })).toBe(true);
    expect(f.rows.workspace_automation_runs![0]!.status).toBe("dismissed");
    expect(f.rows.sms_ai_reply_drafts![0]!.status).toBe("rejected");
    expect(await dismissHeldRun(f.db, { workspaceId: "ws", runId })).toBe(false);
  });

  it("re-checks a held group text against who lives there now", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [settingsRow("announcement", "draft")] });
    await fireAutomation(f.db, { ...base, preset: "announcement", idempotencyKey: "announce:C:P1", vars: { house: "x", announcement: "Pat will do the cleaning" }, target: { kind: "group", house, roster, fallbackToResidents: true } });
    // Nobody called Pat lived there at drafting time; by approval Pat has moved in.
    h.leases = [...roster, lease({ leaseId: "L9", firstName: "Pat", phoneKey: "2065550199" })];
    const runId = String(f.rows.workspace_automation_runs![0]!.id);
    const out = await approveHeldRun(f.db, { workspaceId: "ws", runId });
    expect(out).toMatchObject({ ok: false, reason: "refused" });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("follows a draft the manager already handled from the thread", async () => {
    const { f } = await held();
    f.rows.sms_ai_reply_drafts![0]!.status = "edited_sent";
    expect(await reconcileHeldRuns(f.db)).toBe(1);
    expect(f.rows.workspace_automation_runs![0]!.status).toBe("sent");
  });
});
