/**
 * The PropLane Service vendor roster (admin Service > Vendors): a roster vendor is a manager_vendor_records row owned by
 * the SERVICE OWNER with serviceRoster = true. Add / edit / pause / remove, one intro text per entry, a STOPped number
 * never texted, link-by-phone to an existing vendor account, no duplicate for a number already on the owner's list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const VENDOR_ACCOUNT = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  sends: [] as Array<Record<string, unknown>>,
  sendOk: true,
  sendError: "Could not queue SMS.",
  optedOut: new Set<string>(),
  verifiedProfile: null as { id: string; email: string } | null,
  auditOk: true,
  serviceOwner: "11111111-1111-4111-8111-111111111111" as string | null,
}));

vi.mock("@/lib/service/service-owner.server", () => ({
  resolveServiceOwner: async () => (state.serviceOwner ? { ok: true, ownerUserId: state.serviceOwner } : { ok: false, reason: "not_configured" }),
}));
vi.mock("@/lib/manager-sms-send.server", () => ({
  sendManagerConversationSms: async (_db: unknown, args: Record<string, unknown>) => {
    state.sends.push(args);
    return state.sendOk ? { status: 200, body: { ok: true, outboxId: "ob-1" } } : { status: 409, body: { error: state.sendError } };
  },
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  readVendorTextConsent: async (_db: unknown, input: { phone: string }) => ({
    ok: true,
    state: state.optedOut.has(input.phone) ? "opted_out" : "none",
    conversationKey: "k",
    grantedUnder: null,
    grantSource: null,
  }),
}));
vi.mock("@/lib/one-number/router-lookups.server", () => ({ findVerifiedProfileByPhone: async () => state.verifiedProfile }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-owner" }));
vi.mock("@/lib/tools/audit", () => ({
  writeAuditLog: async () => (state.auditOk ? { recorded: true } : { recorded: false, duplicate: false, error: "x" }),
  updateAuditResult: async () => undefined,
}));

import { addServiceVendor, listServiceVendors, removeServiceVendor, updateServiceVendor } from "@/lib/service/service-vendors.server";
import { cleanServiceVendorInput, composeServiceVendorIntro } from "@/lib/service/service-vendors";

type Db = ReturnType<typeof createMemoryDb>;
let db: Db;

const records = () => db.__tables.manager_vendor_records ?? [];

beforeEach(() => {
  state.sends = [];
  state.sendOk = true;
  state.optedOut = new Set();
  state.verifiedProfile = null;
  state.auditOk = true;
  state.serviceOwner = OWNER;
  db = createMemoryDb({
    manager_vendor_records: [],
    vendor_business_profiles: [{ user_id: VENDOR_ACCOUNT }],
    profiles: [{ id: ADMIN, full_name: "Prakrit Ramachandran" }],
  });
});

const input = (over: Record<string, unknown> = {}) => ({ name: "Sam Locksmith", phone: "(206) 555-0101", trades: ["locksmith", "handyman"], area: "Capitol Hill", ...over });

describe("input rules", () => {
  it("needs a name, a US phone and at least one real trade; area is optional", () => {
    expect(cleanServiceVendorInput(input()).ok).toBe(true);
    expect(cleanServiceVendorInput(input({ name: " " }))).toMatchObject({ ok: false });
    expect(cleanServiceVendorInput(input({ phone: "12345" }))).toMatchObject({ ok: false });
    expect(cleanServiceVendorInput(input({ phone: "+44 20 7946 0958" }))).toMatchObject({ ok: false });
    expect(cleanServiceVendorInput(input({ trades: [] }))).toMatchObject({ ok: false });
    expect(cleanServiceVendorInput(input({ trades: ["wizard"] }))).toMatchObject({ ok: false });
    const ok = cleanServiceVendorInput(input({ area: undefined }));
    expect(ok.ok && ok.value.area).toBe("");
    const phone = cleanServiceVendorInput(input());
    expect(phone.ok && phone.value.phone).toBe("+12065550101");
  });

  it("the intro names PropLane and who added them, says how it works, and leaves STOP to the sender line", () => {
    const text = composeServiceVendorIntro({ adminFirstName: "Prakrit" });
    expect(text).toContain("PropLane");
    expect(text).toContain("Prakrit added you");
    expect(text).toContain("Reply YES to a job to take it");
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("add", () => {
  it("stores a roster row owned by the service owner and sends ONE intro as the service owner with the relationship attested", async () => {
    const result = await addServiceVendor(db as never, ADMIN, input());
    expect(result).toMatchObject({ ok: true, intro: "sent" });
    expect(records()).toHaveLength(1);
    const row = records()[0]!;
    expect(row.manager_user_id).toBe(OWNER);
    expect(String(row.id)).toMatch(/^svcv-/);
    const data = row.row_data as Record<string, unknown>;
    expect(data).toMatchObject({ serviceRoster: true, phone: "+12065550101", dispatchTrades: ["locksmith", "handyman"], serviceArea: "Capitol Hill", consentBasis: "added_by_admin_prior_relationship", rosterAddedBy: ADMIN, active: true });
    expect(data.introSentAt).toBeTruthy();
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ actorUserId: OWNER, toPhone: "+12065550101", vendorRecordId: row.id, attestVendorRelationship: true });
    expect(String(state.sends[0]!.text)).toContain("Prakrit added you");
  });

  it("does not introduce the same entry twice", async () => {
    const added = await addServiceVendor(db as never, ADMIN, input());
    expect(added.ok).toBe(true);
    const { sendServiceVendorIntro } = await import("@/lib/service/service-vendors.server");
    const again = await sendServiceVendorIntro(db as never, { ownerUserId: OWNER, recordId: String(records()[0]!.id), adminUserId: ADMIN });
    expect(again).toBe("already_sent");
    expect(state.sends).toHaveLength(1);
  });

  it("never texts a number that has texted STOP, and says so", async () => {
    state.optedOut.add("+12065550101");
    const result = await addServiceVendor(db as never, ADMIN, input());
    expect(result).toMatchObject({ ok: true, intro: "opted_out" });
    expect(state.sends).toHaveLength(0);
    expect((records()[0]!.row_data as Record<string, unknown>).introSentAt).toBeUndefined();
    const listed = await listServiceVendors(db as never);
    expect(listed.ok && listed.vendors[0]?.optedOut).toBe(true);
  });

  it("a send that fails leaves the vendor added and the intro retryable", async () => {
    state.sendOk = false;
    const result = await addServiceVendor(db as never, ADMIN, input());
    expect(result).toMatchObject({ ok: true, intro: "failed" });
    expect(records()).toHaveLength(1);
    expect((records()[0]!.row_data as Record<string, unknown>).introSentAt).toBeUndefined();
    state.sendOk = true;
  });

  it("refuses a number already on the list (409) and a bad form (400)", async () => {
    await addServiceVendor(db as never, ADMIN, input());
    expect(await addServiceVendor(db as never, ADMIN, input({ name: "Other" }))).toMatchObject({ ok: false, status: 409 });
    expect(await addServiceVendor(db as never, ADMIN, input({ phone: "x" }))).toMatchObject({ ok: false, status: 400 });
    expect(records()).toHaveLength(1);
  });

  it("links to the PropLane vendor account that owns the phone instead of making a second identity", async () => {
    state.verifiedProfile = { id: VENDOR_ACCOUNT, email: "v@example.com" };
    await addServiceVendor(db as never, ADMIN, input());
    expect(records()[0]!.vendor_user_id).toBe(VENDOR_ACCOUNT);
    expect((records()[0]!.row_data as Record<string, unknown>).vendorUserId).toBe(VENDOR_ACCOUNT);
    const listed = await listServiceVendors(db as never);
    expect(listed.ok && listed.vendors[0]?.hasAccount).toBe(true);
  });

  it("promotes a vendor already on the service owner's own list rather than duplicating them", async () => {
    db.__tables.manager_vendor_records!.push({
      id: "own-1",
      manager_user_id: OWNER,
      vendor_user_id: null,
      row_data: { id: "own-1", name: "Sam L", trade: "Locksmith", phone: "+12065550101", active: true, notes: "keeps my keys" },
    });
    await addServiceVendor(db as never, ADMIN, input());
    expect(records()).toHaveLength(1);
    expect(records()[0]!.id).toBe("own-1");
    expect(records()[0]!.row_data).toMatchObject({ serviceRoster: true, notes: "keeps my keys", name: "Sam Locksmith" });
  });

  it("writes nothing when the audit row cannot be recorded", async () => {
    state.auditOk = false;
    expect(await addServiceVendor(db as never, ADMIN, input())).toMatchObject({ ok: false, status: 503 });
    expect(records()).toHaveLength(0);
  });

  it("answers 409 when no service owner is configured", async () => {
    state.serviceOwner = null;
    expect(await addServiceVendor(db as never, ADMIN, input())).toMatchObject({ ok: false, status: 409 });
  });
});

describe("edit, pause, remove", () => {
  async function seeded(): Promise<string> {
    await addServiceVendor(db as never, ADMIN, input());
    state.sends = [];
    return String(records()[0]!.id);
  }

  it("pause and resume only flip dispatch availability", async () => {
    const id = await seeded();
    const paused = await updateServiceVendor(db as never, ADMIN, id, { paused: true });
    expect(paused.ok && paused.vendor.paused).toBe(true);
    expect((records()[0]!.row_data as Record<string, unknown>).dispatchAvailable).toBe(false);
    const resumed = await updateServiceVendor(db as never, ADMIN, id, { paused: false });
    expect(resumed.ok && resumed.vendor.paused).toBe(false);
    expect(state.sends).toHaveLength(0);
  });

  it("editing the trades keeps the intro; a new phone gets its own intro", async () => {
    const id = await seeded();
    await updateServiceVendor(db as never, ADMIN, id, { name: "Sam Locksmith", phone: "(206) 555-0101", trades: ["plumber"], area: "" });
    expect(state.sends).toHaveLength(0);
    expect((records()[0]!.row_data as Record<string, unknown>).dispatchTrades).toEqual(["plumber"]);
    const moved = await updateServiceVendor(db as never, ADMIN, id, { name: "Sam Locksmith", phone: "(206) 555-0199", trades: ["plumber"], area: "" });
    expect(moved).toMatchObject({ ok: true, intro: "sent" });
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]!.toPhone).toBe("+12065550199");
  });

  it("remove is soft: the row stays for history, leaves the list, and the number can be added again", async () => {
    const id = await seeded();
    expect(await removeServiceVendor(db as never, ADMIN, id)).toEqual({ ok: true });
    expect(records()).toHaveLength(1);
    expect(records()[0]!.row_data).toMatchObject({ active: false });
    const listed = await listServiceVendors(db as never);
    expect(listed.ok && listed.vendors).toHaveLength(0);
    expect(await updateServiceVendor(db as never, ADMIN, id, { paused: true })).toMatchObject({ ok: false, status: 404 });
    const back = await addServiceVendor(db as never, ADMIN, input());
    expect(back).toMatchObject({ ok: true, intro: "sent" });
    expect(records()).toHaveLength(1);
    expect(records()[0]!.row_data).toMatchObject({ active: true });
  });

  it("only ever touches a roster row of the service owner: a manager's own vendor id is not found", async () => {
    db.__tables.manager_vendor_records!.push({ id: "m-1", manager_user_id: "someone-else", vendor_user_id: null, row_data: { id: "m-1", name: "X", phone: "+12065550177", active: true, serviceRoster: true } });
    db.__tables.manager_vendor_records!.push({ id: "own-plain", manager_user_id: OWNER, vendor_user_id: null, row_data: { id: "own-plain", name: "Y", phone: "+12065550178", active: true } });
    expect(await removeServiceVendor(db as never, ADMIN, "m-1")).toMatchObject({ ok: false, status: 404 });
    expect(await removeServiceVendor(db as never, ADMIN, "own-plain")).toMatchObject({ ok: false, status: 404 });
    expect(await updateServiceVendor(db as never, ADMIN, "m-1", { paused: true })).toMatchObject({ ok: false, status: 404 });
  });
});
