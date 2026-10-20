import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";
import { linksFakeDb } from "../helpers/links-fake-db";

const mocks = vi.hoisted(() => ({ charges: vi.fn(), identity: vi.fn(), send: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/tools/domains/resident/balance", () => ({ loadOwnCharges: mocks.charges }));
vi.mock("@/lib/tools/domains/leasing-sms", () => ({ resolveLiveListingForSms: vi.fn() }));
vi.mock("@/lib/tools/resident-sms-context", () => ({ resolveResidentSmsAgentContext: mocks.identity }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.send }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { handleLineResidentText } from "@/lib/one-number/line-resident.server";
import { requestLinkUnlockCode, verifyLinkUnlockCode } from "@/lib/one-number/link-unlock.server";
import { resolvePhoneBoundLink } from "@/lib/one-number/links.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const FROM = "+12065550142";
const KEY = "2065550142";
const LINE_OWNER = "u-line";

const seed = () => ({
  sms_runtime_config: [{ singleton: true, line_mode: "per_workspace", shared_number_e164: null, shared_pilot_workspace_ids: [] }],
  profiles: [{ id: "res-1", email: "r@x.com", phone: FROM, phone_verified_at: VERIFIED }],
  portal_workspaces: [
    { id: "ws-x", name: "Maple Homes", owner_user_id: "owner-x", is_default: true },
    { id: "ws-y", name: "Cedar Co", owner_user_id: "owner-y", is_default: true },
  ],
  manager_property_records: [
    { id: "px", manager_user_id: "owner-x", workspace_id: "ws-x", row_data: { buildingName: "12 Maple" } },
    { id: "py", manager_user_id: "owner-y", workspace_id: "ws-y", row_data: { buildingName: "9 Cedar" } },
  ],
  manager_application_records: [
    { id: "a1", manager_user_id: "owner-x", resident_email: "r@x.com", property_id: "px", row_data: { bucket: "approved" } },
  ],
});

const residentCtx = (db: unknown, ownerManagerUserId: string) => ({
  ok: true,
  ctx: { kind: "resident", userId: "res-1", email: "r@x.com", managerIds: [ownerManagerUserId], activeManagerId: ownerManagerUserId, channel: "sms", phase: "approved", db },
});
const open = (id: string, propertyId = "px") => ({ id, status: "pending", propertyId });

beforeEach(() => {
  mocks.charges.mockReset();
  mocks.identity.mockReset();
  mocks.send.mockClear();
});

async function ask(world: ReturnType<typeof linksFakeDb>, body: string, over: Record<string, unknown> = {}) {
  mocks.identity.mockImplementation(async (_db: unknown, args: { ownerManagerUserId: string }) => residentCtx(world.db, args.ownerManagerUserId));
  return handleLineResidentText(world.db, { fromPhone: FROM, body, phoneKey: KEY, lineOwnerUserId: LINE_OWNER, ...over });
}

describe("a resident of another workspace asks the PropLane line for their rent link (per_workspace)", () => {
  it("mints a phone-bound link for the workspace that holds their lease and texts it back", async () => {
    const world = linksFakeDb(seed());
    mocks.charges.mockResolvedValue([open("c1"), { id: "c2", status: "paid", propertyId: "px" }]);
    const result = await ask(world, "hey can you send me my rent link");
    expect(result).toMatchObject({ handled: true, residentUserId: "res-1" });
    const reply = result.handled ? result.reply : "";
    // The link sits on its own line, on the canonical host, with nothing glued to it.
    expect(reply).toMatch(/^Here is your secure payment link for 12 Maple:\nhttps:\/\/proplane\.ai\/l\/[A-Za-z0-9_-]{43}\nWe will text a code to this number when you open it\./);
    // Bound to the texting phone, the lease's workspace and the open charge; a code is required.
    expect(world.rows.phone_bound_links).toHaveLength(1);
    expect(world.rows.phone_bound_links![0]).toMatchObject({
      phone_key: KEY, workspace_id: "ws-x", purpose: "rent", target_type: "charge", target_id: "c1", requires_otp: true, created_by: "res-1",
    });
    // The identity was asked for the landlord that holds the lease, never the line owner.
    expect(mocks.identity).toHaveBeenCalledWith(world.db, { fromPhone: FROM, ownerManagerUserId: "owner-x" });
  });

  it("the link only opens after a code texted to the same phone, from the lease workspace's own number", async () => {
    const world = linksFakeDb(seed());
    mocks.charges.mockResolvedValue([open("c1")]);
    const result = await ask(world, "send me my payment link");
    const token = /\/l\/([A-Za-z0-9_-]{43})/.exec(result.handled ? result.reply : "")![1]!;
    const link = (await resolvePhoneBoundLink(world.db, token, { count: false }))!.link;
    expect(link.requiresOtp).toBe(true);

    expect((await requestLinkUnlockCode(world.db, link)).ok).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent = (mocks.send.mock.calls[0] as unknown as [{ managerUserId: string; workspaceId: string; to: string; text: string; purpose: string }])[0];
    // Owner of the workspace the lease is in, not the PropLane line owner; to the bound phone only.
    expect(sent).toMatchObject({ managerUserId: "owner-x", workspaceId: "ws-x", to: FROM, purpose: "phone_link_code" });
    const code = /\b(\d{6})\b/.exec(sent.text)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifyLinkUnlockCode(world.db, link, wrong)).toEqual({ ok: false, reason: "wrong_code" });
    expect((await verifyLinkUnlockCode(world.db, link, code)).ok).toBe(true);
  });

  it("says so when nothing is due, and mints nothing", async () => {
    const world = linksFakeDb(seed());
    mocks.charges.mockResolvedValue([{ id: "c2", status: "paid", propertyId: "px" }]);
    const result = await ask(world, "how do I pay rent");
    expect(result).toMatchObject({ handled: true, reply: "You have nothing due right now at 12 Maple." });
    expect(world.rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("is not handled when it is not a payment ask, or is a housing search", async () => {
    const world = linksFakeDb(seed());
    mocks.charges.mockResolvedValue([open("c1")]);
    expect(await ask(world, "the faucet is dripping")).toEqual({ handled: false });
    expect(await ask(world, "hey is there any house available")).toEqual({ handled: false });
    expect(await ask(world, "looking for another place to rent")).toEqual({ handled: false });
    expect(world.rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("is not handled for a stranger, an unverified phone, or the line owner's own resident", async () => {
    mocks.charges.mockResolvedValue([open("c1")]);
    const stranger = linksFakeDb({ ...seed(), manager_application_records: [] });
    expect(await ask(stranger, "send me my rent link")).toEqual({ handled: false });
    const unverified = linksFakeDb(seed());
    unverified.rows.profiles![0]!.phone_verified_at = null;
    expect(await ask(unverified, "send me my rent link")).toEqual({ handled: false });
    // Their lease is with the PropLane line's own owner: the work-number resident agent has the same tool.
    const own = linksFakeDb(seed());
    expect(await ask(own, "send me my rent link", { lineOwnerUserId: "owner-x" })).toEqual({ handled: false });
    // The landlord link check failing (not this landlord's resident) hands nothing out.
    const refused = linksFakeDb(seed());
    mocks.identity.mockResolvedValue({ ok: false, reason: "manager_not_linked" });
    expect(await handleLineResidentText(refused.db, { fromPhone: FROM, body: "send me my rent link", phoneKey: KEY, lineOwnerUserId: LINE_OWNER })).toEqual({ handled: false });
    expect(refused.rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("the fallback when a link cannot be minted points at the account, not a hosted checkout", async () => {
    const world = linksFakeDb(seed(), { broken: ["phone_bound_links"] });
    mocks.charges.mockResolvedValue([open("c1")]);
    const result = await ask(world, "send me my rent link");
    expect(result.handled && result.reply).toMatch(/^I cannot text a payment link right now\. You can pay in your PropLane account: .*\/auth\/sign-in/);
  });
});

describe("a resident with two residencies is asked which one, once", () => {
  it("asks, then mints for the one they pick", async () => {
    const db: FakeDb = createFakeDb({
      ...seed(),
      manager_application_records: [
        { id: "a1", manager_user_id: "owner-x", resident_email: "r@x.com", property_id: "px", row_data: { bucket: "approved" } },
        { id: "a2", manager_user_id: "owner-y", resident_email: "r@x.com", property_id: "py", row_data: { bucket: "approved" } },
      ],
    });
    mocks.identity.mockImplementation(async (_db: unknown, args: { ownerManagerUserId: string }) => residentCtx(db, args.ownerManagerUserId));
    mocks.charges.mockResolvedValue([open("c9", "py")]);
    const asked = await handleLineResidentText(db as never, { fromPhone: FROM, body: "send me my rent link", phoneKey: KEY, lineOwnerUserId: LINE_OWNER });
    expect(asked.handled && asked.reply).toMatch(/^Is this about .* or .*\?$/);
    expect(db.tables.sms_line_sessions![0]).toMatchObject({ phone_key: `lr:${KEY}` });
    expect(db.tables.phone_bound_links ?? []).toHaveLength(0);

    const picked = await handleLineResidentText(db as never, { fromPhone: FROM, body: "Cedar", phoneKey: KEY, lineOwnerUserId: LINE_OWNER });
    expect(picked.handled && picked.reply).toContain("payment link for 9 Cedar");
    expect(db.tables.phone_bound_links![0]).toMatchObject({ workspace_id: "ws-y", target_id: "c9" });
  });
});
