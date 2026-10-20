import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

// Room availability is the calendar's own report; the test supplies its answer per house.
const availability = vi.hoisted(() => new Map<string, { rooms: number; vacant: number }>());
vi.mock("@/lib/room-availability-range.server", () => ({
  roomAvailabilityForRange: vi.fn(async (input: { propertyId: string }) => {
    const a = availability.get(input.propertyId);
    if (!a) return { ok: false, error: "listing_unreadable", message: "x" };
    return { ok: true, rooms: Array.from({ length: a.rooms }, (_, i) => ({ roomLabel: `Room ${i + 1}`, available: i < a.vacant })) };
  }),
}));
vi.mock("@/lib/one-number/display-number.server", () => ({
  resolveWorkspaceDisplayNumber: vi.fn(async () => "+12065550111"),
}));

const alerts = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: alerts }));

import { PLANNED_RECORD_ID } from "@/lib/tour-inquiry.server";
import { summarizeRentForMonth } from "@/lib/one-number/ops-text";
import { buildStatusReply, portfolioTotals } from "@/lib/one-number/portfolio-status";
import { readPortfolioStatus } from "@/lib/one-number/portfolio-status.server";
import { handleLineMemberText, listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { answerPropLaneLineText } from "@/lib/one-number/line-inbound.server";

const NOW = new Date("2026-10-19T18:00:00.000Z");
const VERIFIED = "2026-10-01T00:00:00.000Z";
const FROM = "+12065550142";
const KEY = "2065550142";
const LINE_OWNER = "u-line";

const charge = (id: string, propertyId: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "rent",
  rentMonth: "2026-10",
  status: "paid",
  residentUserId: `res-${id}`,
  residentEmail: `${id}@x.com`,
  residentName: `Resident ${id}`,
  propertyId,
  propertyLabel: propertyId,
  amountLabel: "$900",
  balanceLabel: "$900",
  paidAt: "2026-10-17T10:00:00.000Z",
  ...over,
});

const signedLease = (id: string, propertyId: string, leaseEnd: string) => ({
  id,
  propertyId,
  bucket: "signed",
  residentName: "R",
  residentSignature: { name: "R", signedAtIso: "2026-09-01T00:00:00.000Z", role: "resident" },
  managerSignature: { name: "M", signedAtIso: "2026-09-02T00:00:00.000Z", role: "manager" },
  application: { leaseEnd },
});

/** Brooklyn Homes (u-own): two houses, with rent, services, a tour and leases. */
function world(extra: Record<string, Row[]> = {}): FakeDb {
  availability.clear();
  availability.set("p1", { rooms: 3, vacant: 1 });
  availability.set("p2", { rooms: 2, vacant: 0 });
  return createFakeDb({
    profiles: [{ id: "u-own", email: "own@x.com", phone: FROM, phone_verified_at: VERIFIED }],
    portal_workspaces: [
      { id: "ws-a", name: "Brooklyn Homes", owner_user_id: "u-own", is_default: true, is_service: false },
      { id: "ws-line", name: "PropLane Homes", owner_user_id: LINE_OWNER, is_default: true, is_service: true },
    ],
    manager_property_records: [
      { id: "p1", manager_user_id: "u-own", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" }, property_data: {} },
      { id: "p2", manager_user_id: "u-own", workspace_id: "ws-a", row_data: { buildingName: "4709A 8th Ave" }, property_data: {} },
    ],
    portal_household_charge_records: [
      { id: "c1", manager_user_id: "u-own", row_data: charge("c1", "p1") },
      { id: "c2", manager_user_id: "u-own", row_data: charge("c2", "p1", { status: "pending", paidAt: undefined }) },
      { id: "c3", manager_user_id: "u-own", row_data: charge("c3", "p2", { amountLabel: "$1,200", paidAt: "2026-10-01T10:00:00.000Z" }) },
    ],
    portal_work_order_records: [
      { id: "w1", manager_user_id: "u-own", property_id: "p1", row_data: { bucket: "open" } },
      { id: "w2", manager_user_id: "u-own", property_id: "p1", row_data: { bucket: "completed" } },
      { id: "w3", manager_user_id: "u-own", property_id: "p2", row_data: { bucket: "scheduled" } },
    ],
    portal_service_request_records: [{ id: "s1", manager_user_id: "u-own", property_id: "p1", status: "pending", row_data: { status: "pending", propertyId: "p1" } }],
    portal_lease_pipeline_records: [
      { id: "l1", manager_user_id: "u-own", property_id: "p1", row_data: signedLease("l1", "p1", "2026-11-30") },
      { id: "l2", manager_user_id: "u-own", property_id: "p2", row_data: signedLease("l2", "p2", "2027-03-01") },
    ],
    portal_schedule_records: [
      {
        id: PLANNED_RECORD_ID,
        row_data: {
          payload: [
            { kind: "tour", managerUserId: "u-own", propertyId: "p1", start: "2026-10-21T17:30:00.000Z", attendeeName: "Guest" },
            { kind: "tour", managerUserId: "u-own", propertyId: "p1", start: "2026-10-20T17:30:00.000Z", canceledAt: "2026-10-19T00:00:00Z" },
            { kind: "tour", managerUserId: "someone-else", propertyId: "p9", start: "2026-10-20T17:30:00.000Z" },
          ],
        },
      },
    ],
    ...extra,
  });
}

const run = (db: FakeDb, body: string, over: Record<string, unknown> = {}) =>
  handleLineMemberText(db as never, { fromPhone: FROM, body, phoneKey: KEY, mode: "service_line", lineOwnerUserId: LINE_OWNER, now: NOW, ...over } as never);

beforeEach(() => {
  availability.clear();
  alerts.mockClear();
});

describe("get_portfolio_status: every figure is read, never estimated", () => {
  it("reads per-house occupancy, rent, services, the next tour and lease ends from the same reports", async () => {
    const db = world();
    const status = await readPortfolioStatus(
      { db: db as never, ownerUserId: "u-own", workspaceId: "ws-a", workspaceName: "Brooklyn Homes", workspaceIsDefault: true, propertyIds: null, canRead: () => true },
      { now: NOW },
    );
    expect(status.month).toBe("2026-10");
    expect(status.unreadable).toEqual([]);
    // Houses list alphabetically: 4709A before 5259.
    const [eighth, brooklyn] = status.houses;
    expect(brooklyn).toMatchObject({ title: "5259 Brooklyn", rooms: 3, vacantRooms: 1, openServices: 2, leasesEnding: { count: 1, earliest: "2026-11-30" } });
    expect(brooklyn!.nextTour).toMatchObject({ day: "Wed, Oct 21", time: "10:30 am" });
    expect(eighth).toMatchObject({ title: "4709A 8th Ave", rooms: 2, vacantRooms: 0, openServices: 1, nextTour: null, leasesEnding: { count: 0, earliest: null } });

    // The rent numbers are exactly the pure report function over the same charges.
    const rows = world().tables.portal_household_charge_records!.map((r) => r.row_data as never);
    const expected = summarizeRentForMonth(rows.filter((c: { propertyId: string }) => c.propertyId === "p1"), "2026-10");
    expect(brooklyn).toMatchObject({ rentCollectedCents: expected.paidCents, rentOwedCents: expected.unpaidCents, unpaidResidents: expected.unpaidCount });
    expect(brooklyn!.paidLast7).toEqual({ count: 1, cents: 90000 });
    expect(eighth!.paidLast7).toEqual({ count: 0, cents: 0 });

    const totals = portfolioTotals(status);
    expect(totals).toMatchObject({ houses: 2, rooms: 5, vacantRooms: 1, rentCollectedCents: 210000, rentOwedCents: 90000, unpaidResidents: 1, openServices: 3, leasesEnding: 1 });
  });

  it("words the overview and each topic from those figures", async () => {
    const db = world();
    const status = await readPortfolioStatus(
      { db: db as never, ownerUserId: "u-own", workspaceId: "ws-a", workspaceName: "Brooklyn Homes", workspaceIsDefault: true, propertyIds: null, canRead: () => true },
      { now: NOW },
    );
    const overview = buildStatusReply(status, "overview");
    expect(overview).toContain("Brooklyn Homes, October: 2 houses, 4 of 5 rooms occupied.");
    expect(overview).toContain("Rent collected $2,100 of $3,000, 1 unpaid.");
    expect(overview).toContain("3 open services.");
    expect(overview).toContain("Next tour Wed, Oct 21 10:30 am at 5259 Brooklyn.");
    expect(overview).toContain("1 lease ending within 60 days.");
    expect(buildStatusReply(status, "vacancies")).toBe("1 room vacant now: 5259 Brooklyn 1 of 3.");
    expect(buildStatusReply(status, "rent")).toContain("October rent: $2,100 collected of $3,000.");
    expect(buildStatusReply(status, "services")).toBe("3 open services: 4709A 8th Ave 1, 5259 Brooklyn 2.");
    expect(buildStatusReply(status, "leases")).toContain("1 lease ending within 60 days: 5259 Brooklyn 1 (first Nov 30).");
  });

  it("a part that fails to read is named and left out, never counted as zero", async () => {
    const db = world();
    const real = db.from.bind(db);
    (db as { from: unknown }).from = (table: string) => {
      if (table === "portal_work_order_records") {
        const b = real(table) as Record<string, unknown>;
        b.range = () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(r) });
        return b;
      }
      return real(table);
    };
    const status = await readPortfolioStatus(
      { db: db as never, ownerUserId: "u-own", workspaceId: "ws-a", workspaceName: "Brooklyn Homes", workspaceIsDefault: true, propertyIds: null, canRead: () => true },
      { now: NOW },
    );
    expect(status.unreadable).toContain("services");
    expect(status.houses.every((h) => h.openServices === null)).toBe(true);
    expect(portfolioTotals(status).openServices).toBeNull();
    expect(buildStatusReply(status, "overview")).toContain("I could not read services just now.");
  });
});

describe("an owner texting the PropLane line", () => {
  it("gets status of the workspace they own, read only", async () => {
    const db = world();
    const result = await run(db, "how are my houses doing");
    expect(result).toMatchObject({ handled: true, actorUserId: "u-own" });
    expect(result.handled && result.reply).toContain("Brooklyn Homes, October: 2 houses");
    expect(result.handled && result.reply).toContain("Rent collected $2,100 of $3,000");
  });

  it("answers the topic asked, and narrows to the house the text names", async () => {
    const db = world();
    const vacancies = await run(db, "any vacancies?");
    expect(vacancies.handled && vacancies.reply).toBe("1 room vacant now: 5259 Brooklyn 1 of 3.");
    const one = await run(db, "how is 4709A doing");
    expect(one.handled && one.reply).toContain("Brooklyn Homes, October: 1 house, 2 of 2 rooms occupied.");
    expect(one.handled && one.reply).toContain("Rent collected $1,200 of $1,200, all paid.");
    expect(one.handled && one.reply).not.toContain("unpaid");
  });

  it("declines a change and says where to make it; nothing is written", async () => {
    const db = world();
    const nonEmpty = () => JSON.stringify(Object.fromEntries(Object.entries(db.tables).filter(([, rows]) => rows.length > 0)));
    const before = nonEmpty();
    const result = await run(db, "mark room 3 at 5259 rented to Sam");
    expect(result.handled && result.reply).toContain("I can only share status on this line");
    expect(result.handled && result.reply).toContain("+12065550111");
    expect(result.handled && result.reply).toContain("/auth/sign-in");
    expect(nonEmpty()).toBe(before);
  });

  it("falls through for a housing search of their own, and for the line owner's own workspaces", async () => {
    const db = world();
    expect(await run(db, "I'm looking for another place for my sister")).toEqual({ handled: false });
    // They own the workspace behind the line itself: the work-number agent answers them, not this handler.
    expect(await run(db, "how are my houses doing", { lineOwnerUserId: "u-own" })).toEqual({ handled: false });
  });
});

describe("several workspaces: ask once, remember the answer", () => {
  function two() {
    const db = world({
      portal_workspaces: [
        { id: "ws-a", name: "Brooklyn Homes", owner_user_id: "u-own", is_default: true, is_service: false },
        { id: "ws-b", name: "Eighth Ave Co", owner_user_id: "u-own", is_default: false, is_service: false },
        { id: "ws-line", name: "PropLane Homes", owner_user_id: LINE_OWNER, is_default: true, is_service: true },
      ],
    });
    return db;
  }

  it("asks Is this about A or B?, then answers the one they pick and keeps it for the conversation", async () => {
    const db = two();
    const asked = await run(db, "how are my houses doing");
    expect(asked).toMatchObject({ handled: true });
    expect(asked.handled && asked.reply).toBe("Is this about Brooklyn Homes or Eighth Ave Co?");
    expect(db.tables.sms_line_sessions![0]).toMatchObject({ phone_key: `ls:${KEY}` });

    const answered = await run(db, "1");
    expect(answered.handled && answered.reply).toContain("Brooklyn Homes");
    expect(answered.handled && answered.reply).toContain("2 houses");
    // Remembered: the next question is not asked about again.
    const next = await run(db, "unpaid rent");
    expect(next.handled && next.reply).toContain("October rent");
    expect(next.handled && next.reply).not.toContain("Is this about");
  });

  it("a remembered choice older than 10 minutes is not honored: the question is asked again", async () => {
    const db = two();
    await run(db, "how are my houses doing");
    await run(db, "1");
    const row = db.tables.sms_line_sessions![0]!;
    expect(row.current_workspace_id).toBe("ws-a");
    // Fresh: remembered.
    const fresh = await run(db, "unpaid rent");
    expect(fresh.handled && fresh.reply).not.toContain("Is this about");
    // Eleven minutes of silence later (a stranger spoofing this caller ID): asked again, nothing read.
    row.updated_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const stale = await run(db, "unpaid rent");
    expect(stale.handled && stale.reply).toBe("Is this about Brooklyn Homes or Eighth Ave Co?");
    expect(stale.handled && stale.reply).not.toContain("October rent");
  });

  it("a text that names the workspace settles it without a question", async () => {
    const db = two();
    const named = await run(db, "how is Eighth Ave Co doing");
    expect(named.handled && named.reply).toBe("I do not see any houses to report on for Eighth Ave Co.");
  });
});

describe("a PropLane Service client (owner of record) is view only", () => {
  /** Ambika: seated as a Property owner, flagged owner of record, on a service workspace the PropLane service owns. */
  function client() {
    availability.clear();
    availability.set("p1", { rooms: 3, vacant: 1 });
    return createFakeDb({
      profiles: [{ id: "u-amb", email: "amb@x.com", phone: FROM, phone_verified_at: VERIFIED }],
      portal_workspaces: [{ id: "ws-svc", name: "Ambika Homes", owner_user_id: LINE_OWNER, is_default: false, is_service: true }],
      account_link_invites: [
        { id: "i1", inviter_user_id: LINE_OWNER, invitee_user_id: "u-amb", workspace_id: "ws-svc", status: "accepted", team_role: "property_owner", is_owner_of_record: true },
      ],
      manager_property_records: [{ id: "p1", manager_user_id: LINE_OWNER, workspace_id: "ws-svc", row_data: { buildingName: "12 Alder St" }, property_data: {} }],
      portal_household_charge_records: [{ id: "c1", manager_user_id: LINE_OWNER, row_data: charge("c1", "p1", { status: "pending", paidAt: undefined }) }],
      portal_work_order_records: [],
      portal_service_request_records: [],
      portal_lease_pipeline_records: [],
      portal_schedule_records: [],
    });
  }
  // The platform service owner's own line: her workspace IS owned by the line owner, which is the production
  // shape in per_workspace mode — the filter must key on the texter, not on the workspace's owner.
  const asClient = (db: FakeDb, body: string) =>
    handleLineMemberText(db as never, { fromPhone: FROM, body, phoneKey: KEY, mode: "service_line", lineOwnerUserId: LINE_OWNER, now: NOW } as never);

  it("is recognised through the owner-of-record seat the router drops, and sees her own workspace", async () => {
    const db = client();
    expect((await listLineMemberships(db as never, "u-amb"))?.map((m) => [m.workspaceId, m.kind, m.viewOnly])).toEqual([["ws-svc", "owner_of_record", true]]);
    const result = await asClient(db, "how are my houses doing");
    expect(result.handled && result.reply).toContain("Ambika Homes, October: 1 house, 2 of 3 rooms occupied.");
    expect(result.handled && result.reply).toContain("Rent collected $0 of $900, 1 unpaid.");
  });

  it("is answered on the service line even though the platform service owner owns her workspace", async () => {
    // The membership filter exists to keep the LINE OWNER'S OWN workspaces on the work-number agent. Keying it
    // on the workspace's owner instead removed every owner-of-record seat, which is this handler's audience.
    const db = client();
    const result = await handleLineMemberText(
      db as never,
      { fromPhone: FROM, body: "how is rent", phoneKey: KEY, mode: "service_line", lineOwnerUserId: LINE_OWNER, now: NOW } as never,
    );
    expect(result).toMatchObject({ handled: true, actorUserId: "u-amb" });
    expect(result.handled && result.reply).toContain("Ambika Homes");
  });

  it("still leaves the line owner's OWN workspace to their work number", async () => {
    const own = client();
    own.tables.profiles![0]!.id = LINE_OWNER;
    own.tables.portal_workspaces!.push({ id: "ws-line-own", name: "PropLane Homes", owner_user_id: LINE_OWNER, is_default: true, is_service: true });
    own.tables.account_link_invites = [];
    const result = await handleLineMemberText(
      own as never,
      { fromPhone: FROM, body: "status", phoneKey: KEY, mode: "service_line", lineOwnerUserId: LINE_OWNER, now: NOW } as never,
    );
    expect(result).toEqual({ handled: false });
  });

  it("is told it is view only when asking for a change", async () => {
    const result = await asClient(client(), "text the residents that water is off");
    expect(result.handled && result.reply).toContain("Your account is view only");
  });

  it("a seat that is not flagged owner of record, or on a non-service workspace, is not a member", async () => {
    const unflagged = client();
    unflagged.tables.account_link_invites![0]!.is_owner_of_record = false;
    expect(await asClient(unflagged, "status")).toEqual({ handled: false });
    const notService = client();
    notService.tables.portal_workspaces![0]!.is_service = false;
    expect(await asClient(notService, "status")).toEqual({ handled: false });
  });

  it("on the shared line only owners of record are answered here (owners and teammates route to their workspace)", async () => {
    const db = client();
    const shared = await handleLineMemberText(db as never, { fromPhone: FROM, body: "status", phoneKey: KEY, mode: "shared_line", now: NOW } as never);
    expect(shared.handled).toBe(true);
    const owner = world();
    expect(await handleLineMemberText(owner as never, { fromPhone: FROM, body: "status", phoneKey: KEY, mode: "shared_line", now: NOW } as never)).toEqual({ handled: false });
  });
});

describe("a teammate sees only the houses and modules assigned to them", () => {
  function team() {
    const db = world({
      profiles: [
        { id: "u-own", email: "own@x.com", phone: "+12065550999", phone_verified_at: VERIFIED },
        { id: "u-mate", email: "mate@x.com", phone: FROM, phone_verified_at: VERIFIED },
      ],
      account_link_invites: [
        {
          id: "i2",
          inviter_user_id: "u-own",
          invitee_user_id: "u-mate",
          workspace_id: "ws-a",
          status: "accepted",
          team_role: "property_manager",
          assigned_property_ids: ["p1"],
          // Houses and Services at read; Payments not granted.
          property_co_manager_permissions: { p1: { properties: { read: true }, services: { read: true }, calendar: { read: true }, leases: { read: true } } },
        },
      ],
    });
    return db;
  }

  it("lists the one assigned house, with granted modules only", async () => {
    const result = await run(team(), "how are my houses doing");
    const reply = result.handled ? result.reply : "";
    expect(reply).toContain("Brooklyn Homes, October: 1 house");
    expect(reply).not.toContain("4709A");
    expect(reply).toContain("2 open services");
    // Payments was not granted: no rent figure is offered.
    expect(reply).not.toContain("Rent collected");
  });

  it("is told their rent view is not in their access when they ask for it", async () => {
    const result = await run(team(), "who hasn't paid");
    expect(result.handled && result.reply).toBe("Rent is not part of your access on this line.");
  });

  it("a teammate with no assigned houses gets nothing from this line", async () => {
    const db = team();
    db.tables.account_link_invites![0]!.assigned_property_ids = [];
    const result = await run(db, "how are my houses doing");
    expect(result.handled && result.reply).toContain("I do not see any houses assigned to you");
  });
});

describe("a stranger is not recognised", () => {
  it("an unknown phone, an unverified phone and a phone two accounts claim all fall through", async () => {
    expect(await run(world(), "status", { fromPhone: "+12065550777" })).toEqual({ handled: false });
    const unverified = world();
    unverified.tables.profiles![0]!.phone_verified_at = null;
    expect(await run(unverified, "status")).toEqual({ handled: false });
    const twice = world();
    twice.tables.profiles!.push({ id: "u-dup", email: "dup@x.com", phone: FROM, phone_verified_at: VERIFIED });
    expect(await run(twice, "status")).toEqual({ handled: false });
  });

  it("a verified account with no workspace anywhere falls through", async () => {
    const db = world();
    db.tables.portal_workspaces = db.tables.portal_workspaces!.filter((w) => w.owner_user_id !== "u-own");
    expect(await run(db, "status")).toEqual({ handled: false });
  });

  it("never answers about a workspace the sender does not belong to", async () => {
    const db = world();
    db.tables.portal_workspaces!.push({ id: "ws-z", name: "Not Theirs", owner_user_id: "u-z", is_default: true });
    const result = await run(db, "how is Not Theirs doing");
    expect(result.handled && result.reply).not.toContain("Not Theirs");
  });
});

describe("the pipeline gate: only the PropLane service owner's number is the PropLane line", () => {
  const LINE_NUMBER = "+12065550100";
  const onLine = (extra: Record<string, Row[]> = {}) =>
    world({
      platform_service_settings: [{ singleton: true, owner_user_id: LINE_OWNER }],
      manager_sms_numbers: [{ id: "n1", manager_user_id: LINE_OWNER, phone_number: LINE_NUMBER, provision_state: "active", released_at: null }],
      ...extra,
    });

  it("answers a member on the service line and says it was a member", async () => {
    const answer = await answerPropLaneLineText(onLine() as never, { lineOwnerUserId: LINE_OWNER, toPhone: LINE_NUMBER, fromPhone: FROM, body: "any vacancies?" });
    expect(answer).toMatchObject({ kind: "member", actorUserId: "u-own", reply: "1 room vacant now: 5259 Brooklyn 1 of 3." });
  });

  it("is silent on any other work number, even for a member, so nothing about the line changes there", async () => {
    // A number that belongs to somebody else, and a line owner who is not the platform service owner.
    expect(await answerPropLaneLineText(onLine() as never, { lineOwnerUserId: "u-other", toPhone: "+12065550999", fromPhone: FROM, body: "any vacancies?" })).toBeNull();
    expect(await answerPropLaneLineText(world() as never, { lineOwnerUserId: LINE_OWNER, toPhone: LINE_NUMBER, fromPhone: FROM, body: "any vacancies?" })).toBeNull();
  });

  it("a landlord asking is there any house available is asking about their own vacancies", async () => {
    const answer = await answerPropLaneLineText(onLine() as never, { lineOwnerUserId: LINE_OWNER, toPhone: LINE_NUMBER, fromPhone: FROM, body: "hey is there any house available" });
    expect(answer).toMatchObject({ kind: "member" });
  });

  it("falls through for a housing search of their own and for a stranger on the line", async () => {
    expect(await answerPropLaneLineText(onLine() as never, { lineOwnerUserId: LINE_OWNER, toPhone: LINE_NUMBER, fromPhone: FROM, body: "I'm looking for another place to live" })).toBeNull();
    expect(await answerPropLaneLineText(onLine() as never, { lineOwnerUserId: LINE_OWNER, toPhone: LINE_NUMBER, fromPhone: "+12065550777", body: "any vacancies?" })).toBeNull();
  });
});

describe("keywords and emergencies from a known member are never answered with a status report", () => {
  it.each(["EMERGENCY", "HUMAN", "human please", "STOP", "HELP", "START", "flood in room 3", "there is a fire at 5259 Brooklyn", "gas leak!!", "water everywhere in the basement", "smoke in the hallway", "I am locked out"])(
    "%s falls through to the keyword path (handled: false)",
    async (body) => {
      expect(await run(world(), body)).toEqual({ handled: false });
      expect(alerts).not.toHaveBeenCalled();
    },
  );

  it("an emergency falls through before any lookup, on the shared line too", async () => {
    const db = createFakeDb({ profiles: [], portal_workspaces: [] });
    const shared = await handleLineMemberText(db as never, { fromPhone: FROM, body: "FIRE in the kitchen", phoneKey: KEY, mode: "shared_line", now: NOW } as never);
    expect(shared).toEqual({ handled: false });
  });

  it("a plain status question still gets its answer", async () => {
    const result = await run(world(), "how are my houses doing");
    expect(result.handled && result.reply).toContain("Brooklyn Homes, October");
  });
});

describe("a member's request or problem is not answered with a status dump", () => {
  it("points a free-form request at the work number and the portal, and tells the team once", async () => {
    const result = await run(world(), "can you get a locksmith to copy the spare key for Sam", { messageSid: "SM1" });
    expect(result.handled && result.reply).toContain("text your work number +12065550111 or use the portal");
    expect(result.handled && result.reply).not.toContain("rooms occupied");
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws-a", ownerUserId: "u-own", kind: "unanswered", urgent: false, idempotencyKey: "line-member-request:SM1:ws-a" }));
  });

  it("a problem report with a status word in it (broken, leaking) is a report, not a services overview", async () => {
    const result = await run(world(), "the dishwasher is broken at 5259");
    expect(result.handled && result.reply).toContain("or use the portal");
    expect(result.handled && result.reply).not.toContain("open service");
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it("a view only client is told their team makes changes, and the team is not pinged", async () => {
    availability.clear();
    availability.set("p1", { rooms: 3, vacant: 1 });
    const db = createFakeDb({
      profiles: [{ id: "u-amb", email: "amb@x.com", phone: FROM, phone_verified_at: VERIFIED }],
      portal_workspaces: [{ id: "ws-svc", name: "Ambika Homes", owner_user_id: LINE_OWNER, is_default: false, is_service: true }],
      account_link_invites: [{ id: "i1", inviter_user_id: LINE_OWNER, invitee_user_id: "u-amb", workspace_id: "ws-svc", status: "accepted", team_role: "property_owner", is_owner_of_record: true }],
      manager_property_records: [{ id: "p1", manager_user_id: LINE_OWNER, workspace_id: "ws-svc", row_data: { buildingName: "12 Alder St" }, property_data: {} }],
      portal_household_charge_records: [], portal_work_order_records: [], portal_service_request_records: [], portal_lease_pipeline_records: [], portal_schedule_records: [],
    });
    const result = await handleLineMemberText(db as never, { fromPhone: FROM, body: "the faucet is leaking in the kitchen", phoneKey: KEY, mode: "service_line", lineOwnerUserId: "u-x", now: NOW } as never);
    expect(result.handled && result.reply).toContain("view only");
    expect(alerts).not.toHaveBeenCalled();
  });

  it("a bare house name or a status question is still an overview, with no alert", async () => {
    const named = await run(world(), "5259 Brooklyn");
    expect(named.handled && named.reply).toContain("Brooklyn Homes, October");
    expect(alerts).not.toHaveBeenCalled();
  });
});
