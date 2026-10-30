 
// The vendor loop by text, end to end, over the in-memory database the engine tests use: a lockout is filed,
// the manager approves by text (nothing reaches a vendor first), the first vendor says NO, the next says YES
// with a time and a price, the service is Scheduled, the vendor says DONE, the resident says YES.
// The transport is replaced by a recorder; every state change below is the real engine's.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchDb } from "../../unit/support/dispatch-memory-db";

const sent = vi.hoisted(() => ({
  vendor: [] as Array<{ vendorDirectoryId: string; phone: string; text: string; ownerUserId: string }>,
  keys: new Set<string>(),
  team: [] as Array<{ memberUserId: string; text: string; ownerUserId: string }>,
  resident: [] as Array<{ residentUserId: string; text: string }>,
  optedOut: new Set<string>(),
}));

vi.mock("@/lib/vendor-dispatch/send.server", () => ({
  workspaceOnSharedLine: async () => true,
  sendVendorDispatchText: async (_db: unknown, input: { vendorDirectoryId: string; phone: string; text: string; ownerUserId: string; idempotencyKey: string }) => {
    if (sent.keys.has(input.idempotencyKey)) return { ok: true, outboxId: null };
    sent.keys.add(input.idempotencyKey);
    sent.vendor.push({ vendorDirectoryId: input.vendorDirectoryId, phone: input.phone, text: input.text, ownerUserId: input.ownerUserId });
    return { ok: true, outboxId: null };
  },
  sendTeamMemberDispatchText: async (_db: unknown, input: { memberUserId: string; text: string; ownerUserId: string }) => {
    sent.team.push({ memberUserId: input.memberUserId, text: input.text, ownerUserId: input.ownerUserId });
    return { ok: true, outboxId: null };
  },
  sendResidentDispatchText: async (_db: unknown, input: { residentUserId: string; text: string }) => {
    sent.resident.push({ residentUserId: input.residentUserId, text: input.text });
    return { ok: true, outboxId: null };
  },
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  readVendorTextConsent: async (_db: unknown, input: { phone: string }) => ({
    ok: true, state: sent.optedOut.has(input.phone) ? "opted_out" : "granted", conversationKey: "k", grantedUnder: "k", grantSource: "test",
  }),
}));
vi.mock("@/lib/team-comms.server", () => ({
  resolveWorkspaceTeamMembersWithGrants: async (_db: unknown, input: { ownerManagerUserId: string }) => [{ userId: input.ownerManagerUserId, teamRole: null, isOwner: true, grantRow: null }],
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => ({ eventId: "e", duplicate: false, delivered: 0, deferred: 0, failed: 0 }) }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_db: unknown, _owner: string, row: unknown) => row }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => undefined }));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({ requestResidentConfirmation: async () => null, resolveResidentConfirmationBySms: async () => null }));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: async () => undefined }));
vi.mock("@/lib/vendor-invoice-submit.server", () => ({ prepareVendorInvoiceSubmission: async () => ({}), insertVendorInvoiceRow: async () => ({ data: null }) }));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: async () => ({ id: "bill" }) }));
vi.mock("@/lib/vendor-invoice-decision-notify.server", () => ({ notifyVendorOfInvoiceDecision: async () => undefined }));
vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: async () => ({ ok: true }) }));
vi.mock("@/lib/agent/portal-assistant-session.server", () => ({ readPortalAssistantSmsSession: async () => ({ ok: true, session: null }) }));
vi.mock("@/lib/sms/agent-confirmation.server", () => ({ classifySmsConfirmationReply: () => "none", resolveOpenSmsProposal: async () => ({ status: "none" }) }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-1" }));

import { createDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { sweepVendorDispatch } from "@/lib/vendor-dispatch/sweep.server";
import { handleManagerDispatchReply, handleResidentDispatchReply, handleVendorDispatchMedia, handleVendorDispatchReply } from "@/lib/vendor-dispatch/inbound.server";

type Row = Record<string, unknown>;
const RESIDENT = "resident-1";
const OWNER = "owner-1";
const OWNER2 = "owner-2";
const WS = "ws-1";
const WS2 = "ws-2";
const PROP = "prop-1";
const T0 = new Date("2026-10-19T20:00:00Z"); // Monday 1pm Pacific

const vendor = (id: string, name: string, phone: string, owner = OWNER): Row => ({
  id, manager_user_id: owner, vendor_user_id: null,
  row_data: { id, name, trade: "Locksmith", trades: ["Locksmith"], phone, email: "", notes: "", active: true },
});

function world() {
  return createDispatchDb({
    manager_property_records: [
      { id: PROP, manager_user_id: OWNER, workspace_id: WS, property_data: { address: "5259 Brooklyn Ave NE, Seattle, WA 98105", title: "5259 Brooklyn" } },
      { id: "prop-2", manager_user_id: OWNER2, workspace_id: WS2, property_data: { address: "9 Other St, Seattle, WA 98105", title: "9 Other" } },
    ],
    manager_vendor_records: [
      vendor("v1", "Sam Locksmith", "(206) 555-0101"), vendor("v2", "Lee Locks", "(206) 555-0102"), vendor("v3", "Kim Keys", "(206) 555-0103"),
      vendor("w1", "Other Locks", "(206) 555-0201", OWNER2),
    ],
    vendor_dispatch_rules: [
      { id: "r1", workspace_id: WS, owner_user_id: OWNER, name: "Lockouts", trade: "locksmith", issue: "lockout", property_scope: "all", property_ids: [], urgencies: ["emergency", "urgent", "routine"], hours: "any", mode: "sequential", broadcast_size: 3, timeout_minutes: null, pay_cents: 12000, pay_model: "flat", nte_cents: 18000, approval: "always", active: true, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
      { id: "r2", workspace_id: WS2, owner_user_id: OWNER2, name: "Lockouts", trade: "locksmith", issue: "lockout", property_scope: "all", property_ids: [], urgencies: ["emergency", "urgent", "routine"], hours: "any", mode: "sequential", broadcast_size: 3, timeout_minutes: null, pay_cents: 9000, pay_model: "flat", nte_cents: null, approval: "always", active: true, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
    ],
    vendor_dispatch_rule_vendors: [
      { rule_id: "r1", vendor_directory_id: "v1", position: 0 }, { rule_id: "r1", vendor_directory_id: "v2", position: 1 }, { rule_id: "r1", vendor_directory_id: "v3", position: 2 },
      { rule_id: "r2", vendor_directory_id: "w1", position: 0 },
    ],
    portal_work_order_records: [
      { id: "wo-1", manager_user_id: OWNER, resident_user_id: RESIDENT, vendor_user_id: null, row_data: { id: "wo-1", reference: "WO-1", propertyName: "5259 Brooklyn", unit: "R3", title: "Locked out", priority: "Emergency", status: "Submitted", bucket: "open", description: "I am locked out, call me at (206) 555-0142 or dana@example.com", propertyAddress: "5259 Brooklyn Ave NE, Seattle, WA 98105", propertyId: PROP, managerUserId: OWNER, residentName: "Dana Lee", residentEmail: "dana@example.com", category: "access" } },
    ],
    profiles: [{ id: OWNER, email: "owner@example.com", full_name: "Olive Owner" }],
  });
}
type Db = ReturnType<typeof world>;
const rows = (db: Db, table: string) => db.__tables[table] ?? [];

async function fileLockout(db: Db) {
  const created = await createDispatchRun(db as never, {
    workspaceId: WS, ownerUserId: OWNER, sourceType: "work_order", sourceId: "wo-1", trade: "locksmith", issue: "lockout", urgency: "emergency",
    propertyId: PROP, residentEmail: "dana@example.com", createdBy: null, at: T0,
    details: { what: "Lockout", room: "R3", personFirstName: "Dana", summary: "call me at (206) 555-0142 or dana@example.com" },
  });
  if (!created.ok) throw new Error(created.reason);
  return created.run;
}
const manager = (db: Db, body: string, over: Partial<Parameters<typeof handleManagerDispatchReply>[1]> = {}) =>
  handleManagerDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, actorUserId: OWNER, body, now: T0, assistantProposalOpen: async () => false, ...over });
const vendorSays = (db: Db, phone: string, body: string, over: Record<string, unknown> = {}) =>
  handleVendorDispatchReply(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: phone, body, messageSid: `SM${Math.random()}`, now: T0, ...over });

beforeEach(() => {
  sent.vendor.length = 0; sent.keys.clear(); sent.team.length = 0; sent.resident.length = 0; sent.optedOut.clear();
});

describe("a lockout, start to finish by text", () => {
  it("manager approves, vendor 1 declines, vendor 2 accepts with a time, DONE, the resident confirms", async () => {
    const db = world();
    const run = await fileLockout(db);

    // 1. The manager is asked; no vendor has been texted.
    expect(sent.vendor).toEqual([]);
    expect(sent.team).toHaveLength(1);
    expect(sent.team[0]!.text).toBe("Lockout 5259 Brooklyn Ave NE R3 #1. Send Sam Locksmith $120, then Lee Locks, Kim Keys if busy? Y/N or 1-3 to pick one");
    expect(sent.team[0]!.text.length).toBeLessThanOrEqual(160);

    // 2. The manager says Y. Vendor 1 gets the offer: area, pay and a first name, never the street or the resident's contact.
    expect(await manager(db, "Y")).toMatchObject({ handled: true, reply: "Approved #1. Texting now." });
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v1"]);
    expect(sent.vendor[0]!.text).toMatch(/^PropLane job/);
    expect(sent.vendor[0]!.text).not.toMatch(/5259|Brooklyn|555-0142|dana@/);

    // 3. Vendor 1 says NO: vendor 2 is offered (and only vendor 2).
    expect(await vendorSays(db, "+12065550101", "NO")).toMatchObject({ handled: true });
    const offers = () => sent.vendor.filter((v) => v.text.startsWith("PropLane job")).map((v) => v.vendorDirectoryId);
    expect(offers()).toEqual(["v1", "v2"]);

    // 4. Vendor 2 says YES 2:30pm: the service is Scheduled, everyone is told once, and only now does the street go out.
    expect(await vendorSays(db, "+12065550102", "YES 2:30pm")).toMatchObject({ handled: true });
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ status: "accepted", accepted_vendor_directory_id: "v2", scheduled_for: "2026-10-19T21:30:00.000Z", agreed_cents: 12000 });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ vendorId: "v2", bucket: "scheduled", status: "Scheduled" });
    expect(sent.team.at(-1)!.text).toBe("Lee accepted, ~2:30pm #1");
    expect(sent.resident.at(-1)!.text).toBe("Lee (locksmith) is coming around 2:30pm.");
    expect(sent.vendor.at(-1)!.text).toContain("5259 Brooklyn Ave NE");
    expect(sent.vendor.at(-1)!.text).not.toMatch(/555-0142|@/);
    // Vendor 3 was never contacted.
    expect(sent.vendor.some((v) => v.vendorDirectoryId === "v3")).toBe(false);

    // 5. DONE: the resident is asked; a stranger's YES is ignored; the resident's YES completes it.
    expect(await vendorSays(db, "+12065550102", "DONE")).toMatchObject({ handled: true });
    expect(sent.resident.at(-1)!.text).toBe("Your service is done. Is it fixed? Reply YES or NO");
    expect(await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentUserId: "stranger", residentEmail: "someone@else.com", body: "YES", now: T0 })).toEqual({ handled: false });
    const before = sent.team.length;
    expect(await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentUserId: "replacement", residentEmail: "dana@example.com", body: "YES", now: T0 })).toEqual({ handled: false });
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ status: "accepted", completion_state: "awaiting_resident" });
    expect(sent.team).toHaveLength(before);
    expect(await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "dana@example.com", body: "YES", now: T0 })).toMatchObject({ handled: true });
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ status: "completed", completion_state: "confirmed" });
    expect(rows(db, "portal_work_order_records")[0]!.row_data).toMatchObject({ bucket: "completed", status: "Completed" });

    // Every text the system wrote is one plain GSM-7 segment.
    const all = [...sent.vendor.map((v) => v.text), ...sent.team.map((t) => t.text), ...sent.resident.map((r) => r.text)];
    for (const text of all) {
      expect(text.length, text).toBeLessThanOrEqual(160);
      expect(/^[\x20-\x7E]*$/.test(text), text).toBe(true);
    }
    expect(run.handle).toBe(1);
  });

  it("a resident who says NO reopens the service and tells the manager; the vendor can finish again", async () => {
    const db = world();
    await fileLockout(db);
    await manager(db, "Y");
    await vendorSays(db, "+12065550101", "YES 2pm");
    await vendorSays(db, "+12065550101", "DONE");
    sent.team.length = 0;
    await handleResidentDispatchReply(db as never, { ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "dana@example.com", body: "no", now: T0 });
    expect(rows(db, "vendor_dispatch_runs")[0]).toMatchObject({ status: "accepted", completion_state: "reopened" });
    expect(sent.team.at(-1)!.text).toMatch(/NOT fixed/);
    expect(await vendorSays(db, "+12065550101", "DONE")).toMatchObject({ handled: true });
  });

  it("a price over the cap goes back to the manager before it is booked", async () => {
    const db = world();
    await fileLockout(db);
    await manager(db, "Y");
    await vendorSays(db, "+12065550101", "YES $240");
    expect(sent.team.at(-1)!.text).toBe("Sam quotes $240 (cap $180) #1. Y/N");
    expect(rows(db, "vendor_dispatch_runs")[0]!.status).not.toBe("accepted");
  });
});

describe("teams stay apart", () => {
  it("another team's manager cannot approve this run, and another team's vendor cannot answer for it", async () => {
    const db = world();
    await fileLockout(db);
    // Owner 2 says "Y 1": owner 2 has no run #1, so nothing is approved and nothing is sent to anyone.
    expect(await manager(db, "Y 1", { ownerUserId: OWNER2, workspaceId: WS2, actorUserId: OWNER2 })).toEqual({ handled: false });
    // A stranger on the same team is not an approver.
    expect(await manager(db, "Y", { actorUserId: "stranger" })).toEqual({ handled: false });
    expect(rows(db, "vendor_dispatch_runs")[0]!.status).toBe("awaiting_approval");
    expect(sent.vendor).toEqual([]);
    await manager(db, "Y");
    // A vendor who is not on this job is ignored; so is the right vendor on the wrong workspace.
    expect(await vendorSays(db, "+12065559999", "YES")).toEqual({ handled: false });
    expect(await vendorSays(db, "+12065550101", "YES", { ownerUserId: OWNER2, workspaceId: WS2 })).toEqual({ handled: false });
    expect(rows(db, "vendor_dispatch_runs")[0]!.status).toBe("offering");
  });

  it("a vendor who texted STOP is skipped, not stuck", async () => {
    const db = world();
    sent.optedOut.add("+12065550101");
    await fileLockout(db);
    await manager(db, "Y");
    expect(sent.vendor.map((v) => v.vendorDirectoryId)).toEqual(["v2"]);
  });

  it("a gas smell is never dispatched", async () => {
    const db = world();
    const out = await createDispatchRun(db as never, {
      workspaceId: WS, ownerUserId: OWNER, sourceType: "manual", sourceId: "m1", trade: "plumber", issue: "gas_smell", urgency: "emergency", details: {}, at: T0,
    });
    expect(out).toMatchObject({ ok: false, reason: "never_auto" });
    expect(sent.team).toEqual([]);
    expect(sent.vendor).toEqual([]);
  });
});

describe("completion photos by text", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  /**
   * The private buckets, in memory: every path "downloads" the same tiny PNG, and a completion-photo
   * upload is kept so the paths written on the service can be checked against what was stored.
   */
  const uploads: string[] = [];
  const withStorage = (db: Db) => {
    (db as unknown as { storage: unknown }).storage = {
      from: () => ({
        download: async () => ({ data: new Blob([PNG], { type: "image/png" }), error: null }),
        upload: async (path: string) => {
          uploads.push(path);
          return { data: { path }, error: null };
        },
      }),
    };
    return db;
  };
  const media = (db: Db, sid: string, owner = OWNER) => {
    rows(db, "sms_media_files").push({
      id: `f-${sid}`, message_sid: sid, media_index: 0, sender_phone_key: "2065550101", storage_path: `manager/${owner}/${sid}/0.png`,
      content_type: "image/png", byte_size: PNG.length, linked_type: null, linked_id: null, created_at: T0.toISOString(),
    });
  };
  const accepted = async (db: Db) => {
    await fileLockout(db);
    await manager(db, "Y");
    await vendorSays(db, "+12065550101", "YES 2:30pm");
  };

  beforeEach(() => {
    uploads.length = 0;
  });

  it("a bare photo from the accepted vendor goes on the service as a completion photo and the vendor is told", async () => {
    const db = withStorage(world());
    (db as unknown as { __tables: Record<string, Row[]> }).__tables.sms_media_files ??= [];
    await accepted(db);
    media(db, "SMphoto1");
    sent.vendor.length = 0;
    const out = await handleVendorDispatchMedia(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: "+12065550101", body: "", messageSid: "SMphoto1", mediaCount: 1, now: T0 });
    expect(out).toMatchObject({ handled: true });
    const order = rows(db, "portal_work_order_records")[0]!.row_data as { completionPhotoPaths?: string[] };
    // The bytes go to the private bucket; only the path is on the row (never base64).
    expect(order.completionPhotoPaths).toHaveLength(1);
    expect(order.completionPhotoPaths![0]).toMatch(/^manager\/owner-1\/service-completion\/wo-1\/[\w-]+\.png$/);
    expect(uploads).toEqual(order.completionPhotoPaths);
    expect(rows(db, "sms_media_files")[0]).toMatchObject({ linked_type: "vendor_job", linked_id: "wo-1" });
    expect(sent.vendor.at(-1)!.text).toBe("Got your photo for #1. Reply DONE when the job is finished");
    // The photo is on the audit trail.
    expect(rows(db, "action_events").some((e) => e.event_type === "vendor_photos")).toBe(true);
  });

  it("DONE with a photo attaches it before the service is marked done", async () => {
    const db = withStorage(world());
    (db as unknown as { __tables: Record<string, Row[]> }).__tables.sms_media_files ??= [];
    await accepted(db);
    media(db, "SMdone1");
    await vendorSays(db, "+12065550101", "DONE", { messageSid: "SMdone1", mediaCount: 1 });
    const order = rows(db, "portal_work_order_records")[0]!.row_data as { completionPhotoPaths?: string[]; automationStatus?: string };
    expect(order.completionPhotoPaths).toHaveLength(1);
    expect(order.automationStatus).toBe("vendor_marked_done");
  });

  it("a photo from a phone with no accepted job is not ours, and another owner's file is never attached", async () => {
    const db = withStorage(world());
    (db as unknown as { __tables: Record<string, Row[]> }).__tables.sms_media_files ??= [];
    await accepted(db);
    // Not the accepted vendor.
    media(db, "SMother1");
    expect(await handleVendorDispatchMedia(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: "+12065550102", body: "", messageSid: "SMother1", mediaCount: 1, now: T0 })).toEqual({ handled: false });
    // The right vendor, but the file sits under another owner's path: nothing is attached.
    media(db, "SMforeign", OWNER2);
    await handleVendorDispatchMedia(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: "+12065550101", body: "", messageSid: "SMforeign", mediaCount: 1, now: T0 });
    const order = rows(db, "portal_work_order_records")[0]!.row_data as { completionPhotoPaths?: string[] };
    expect(order.completionPhotoPaths ?? []).toHaveLength(0);
    expect(uploads).toEqual([]);
    expect(sent.vendor.at(-1)!.text).toMatch(/Could not save that photo for #1/);
    // No photo at all.
    expect(await handleVendorDispatchMedia(db as never, { ownerUserId: OWNER, workspaceId: WS, phoneE164: "+12065550101", body: "hi", messageSid: "SMnone", mediaCount: 0, now: T0 })).toEqual({ handled: false });
  });
});

describe("the hour-before reminder", () => {
  const minutesAfter = (m: number) => new Date(T0.getTime() + m * 60_000);
  const sweep = (db: Db, at: Date) => sweepVendorDispatch(db as never, at, { turnovers: false });
  const reminders = () => sent.vendor.filter((v) => v.text.startsWith("Reminder:"));

  it("texts the accepted vendor once, about an hour before the agreed time, and never twice", async () => {
    const db = world();
    await fileLockout(db);
    await manager(db, "Y");
    await vendorSays(db, "+12065550101", "YES 2:30pm"); // 21:30Z, accepted at 20:00Z
    // Too early (two hours out): nothing.
    expect((await sweep(db, minutesAfter(0))).jobReminders).toBe(0);
    // 31 minutes later it is 59 minutes before the visit: the reminder goes.
    expect((await sweep(db, minutesAfter(31))).jobReminders).toBe(1);
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ vendorDirectoryId: "v1" });
    expect(reminders()[0]!.text).toMatch(/^Reminder: #1 at .*2:30pm\. Reply DONE when finished$/);
    expect(reminders()[0]!.text.length).toBeLessThanOrEqual(160);
    // The next ticks do not text again.
    await sweep(db, minutesAfter(33));
    await sweep(db, minutesAfter(45));
    expect(reminders()).toHaveLength(1);
  });

  it("does not remind a finished job, a job already past, or a job accepted minutes ago", async () => {
    const done = world();
    await fileLockout(done);
    await manager(done, "Y");
    await vendorSays(done, "+12065550101", "YES 2:30pm");
    await vendorSays(done, "+12065550101", "DONE");
    expect((await sweep(done, minutesAfter(40))).jobReminders).toBe(0);

    const late = world();
    await fileLockout(late);
    await manager(late, "Y");
    await vendorSays(late, "+12065550101", "YES 2:30pm");
    expect((await sweep(late, minutesAfter(100))).jobReminders).toBe(0); // 21:40Z, after the visit time

    const fresh = world();
    await fileLockout(fresh);
    await manager(fresh, "Y");
    await vendorSays(fresh, "+12065550101", "YES 1pm"); // 20:00Z, now
    expect((await sweep(fresh, minutesAfter(5))).jobReminders).toBe(0);
    expect(reminders()).toHaveLength(0);
  });
});
