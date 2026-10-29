/**
 * MONEY: the waive-code routes behind the inline "Promo codes" row. The client sends only the code text, the fee
 * and a property id; the server decides whose code it is (the session's manager) and refuses a property the
 * manager does not own. Ids in a body are never authorization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ ctx: null as { db: unknown; userId: string } | null }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: async () => h.ctx }));

import { GET, POST } from "@/app/api/manager/application-fee-waivers/route";
import { PATCH } from "@/app/api/manager/application-fee-waivers/[id]/route";
import { resolveWaiverWriteScope, waiverCodeIsReadOnly } from "@/lib/application-fee-waiver-scope.server";

let tables: Record<string, Row[]>;

beforeEach(() => {
  tables = {
    manager_property_records: [
      { id: "prop-mine", manager_user_id: MANAGER },
      { id: "prop-theirs", manager_user_id: OTHER },
    ],
    manager_application_fee_waiver_codes: [
      { id: "code-theirs", manager_user_id: OTHER, code: "THEIRS", code_normalized: "THEIRS", status: "active", applies_to: "application", used_count: 0 },
    ],
  };
  h.ctx = { db: fakeSupabaseClient(tables), userId: MANAGER };
});

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/manager/application-fee-waivers", { method: "POST", body: JSON.stringify(body) }));
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/manager/application-fee-waivers/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const mine = () => tables.manager_application_fee_waiver_codes!.filter((r) => r.manager_user_id === MANAGER);

describe("POST /api/manager/application-fee-waivers (the inline Promo codes row)", () => {
  it("needs a signed-in manager", async () => {
    h.ctx = null;
    expect((await post({ code: "WELCOME", appliesTo: "lease", propertyIds: ["prop-mine"] })).status).toBe(401);
    expect(mine()).toHaveLength(0);
  });

  it("creates a lease code limited to the manager's own property, owned by the session manager", async () => {
    const res = await post({ code: "welcome", appliesTo: "lease", propertyIds: ["prop-mine"] });
    expect(res.status).toBe(200);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ code: "WELCOME", applies_to: "lease", property_ids: ["prop-mine"], manager_user_id: MANAGER });
  });

  it("ignores a manager id (or any owner field) in the body: the code belongs to the session", async () => {
    const res = await post({ code: "SNEAKY", appliesTo: "application", propertyIds: ["prop-mine"], managerUserId: OTHER, manager_user_id: OTHER });
    expect(res.status).toBe(200);
    const row = tables.manager_application_fee_waiver_codes!.find((r) => r.code === "SNEAKY")!;
    expect(row.manager_user_id).toBe(MANAGER);
  });

  it("refuses another manager's property, writing nothing", async () => {
    // No grant on their house is a 403 now (it was a 400 "not your portfolio"); either way nothing is written.
    const res = await post({ code: "STEAL", appliesTo: "lease", propertyIds: ["prop-theirs"] });
    expect(res.status).toBe(403);
    expect(mine()).toHaveLength(0);
    // A mixed list is refused whole.
    expect((await post({ code: "MIXED", propertyIds: ["prop-mine", "prop-theirs"] })).status).toBe(400);
    expect(mine()).toHaveLength(0);
  });

  it("refuses a property list that is not a list, and ids that are not strings", async () => {
    expect((await post({ code: "NOTLIST", propertyIds: "prop-mine" })).status).toBe(400);
    expect((await post({ code: "NOTSTR", propertyIds: [{ id: "prop-mine" }] })).status).toBe(400);
    expect(mine()).toHaveLength(0);
  });

  it("refuses a malformed code with the existing rule", async () => {
    const res = await post({ code: "ab", appliesTo: "lease", propertyIds: ["prop-mine"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/4-32/);
  });
});

describe("PATCH /api/manager/application-fee-waivers/[id] (turn a code off)", () => {
  it("turns off the manager's own code", async () => {
    await post({ code: "MINE-ONE", appliesTo: "application", propertyIds: ["prop-mine"] });
    const id = String(mine()[0]!.id);
    expect((await patch(id, { action: "revoke" })).status).toBe(200);
    expect(mine()[0]!.status).toBe("revoked");
  });

  it("cannot reach another manager's code", async () => {
    const res = await patch("code-theirs", { action: "revoke" });
    expect(res.status).toBe(404);
    expect(tables.manager_application_fee_waiver_codes!.find((r) => r.id === "code-theirs")!.status).toBe("active");
  });
});


/* ----------------------------------------------------------------------------------------------------------------
 * A code belongs to the PROPERTY'S owner. A teammate (co-manager, or PropLane staff seated on a service workspace)
 * acts on the owner's code table; a seat is an accepted `account_link_invites` row, the very grant
 * `assertCoManagerModuleAccess` reads. The permission resolver here is the REAL one, over seeded rows.
 * -------------------------------------------------------------------------------------------------------------- */

const TEAMMATE = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";
const OWNED = "prop-owned";
const OWNED_2 = "prop-owned-2";
const OWNED_3 = "prop-owned-3";
const ELSEWHERE = "prop-elsewhere";

const applicationsEdit = { read: true, edit: true };

function seat(userId: string, propertyIds: string[], extra: Row = {}): Row {
  return {
    id: `link-${userId}-${propertyIds.join("-")}`,
    inviter_user_id: MANAGER,
    invitee_user_id: userId,
    status: "accepted",
    assigned_property_ids: propertyIds,
    property_co_manager_permissions: Object.fromEntries(propertyIds.map((id) => [id, { applications: applicationsEdit }])),
    team_role: "custom",
    ...extra,
  };
}

function asCaller(userId: string) {
  h.ctx = { db: fakeSupabaseClient(tables), userId };
}

const owned = () => tables.manager_application_fee_waiver_codes!.filter((r) => r.manager_user_id === MANAGER);
const code = (over: Row): Row => ({
  id: `c-${String(over.code)}`,
  manager_user_id: MANAGER,
  code_normalized: over.code,
  status: "active",
  applies_to: "application",
  used_count: 0,
  max_uses: null,
  expires_at: null,
  property_id: null,
  property_ids: null,
  ...over,
});

describe("a teammate adds a promo code on the owner's property", () => {
  beforeEach(() => {
    tables.manager_property_records!.push(
      { id: OWNED, manager_user_id: MANAGER },
      { id: OWNED_2, manager_user_id: MANAGER },
      { id: OWNED_3, manager_user_id: MANAGER },
      { id: ELSEWHERE, manager_user_id: OTHER },
    );
    tables.account_link_invites = [seat(TEAMMATE, [OWNED, OWNED_2])];
  });

  it("stores the code under the OWNER when a co-manager holding Applications at edit adds it", async () => {
    asCaller(TEAMMATE);
    const res = await post({ code: "appwaive", appliesTo: "application", propertyIds: [OWNED] });
    expect(res.status).toBe(200);
    expect(owned()).toHaveLength(1);
    expect(owned()[0]).toMatchObject({ code: "APPWAIVE", manager_user_id: MANAGER, property_ids: [OWNED] });
    expect(tables.manager_application_fee_waiver_codes!.some((r) => r.manager_user_id === TEAMMATE)).toBe(false);
  });

  it("refuses a teammate with no grant on the property (403) and writes nothing", async () => {
    asCaller(TEAMMATE);
    const res = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED_3] });
    expect(res.status).toBe(403);
    expect(owned()).toHaveLength(0);
  });

  it("refuses a read-only grant: Applications must be at edit", async () => {
    tables.account_link_invites = [seat(TEAMMATE, [OWNED], { property_co_manager_permissions: { [OWNED]: { applications: { read: true } } } })];
    asCaller(TEAMMATE);
    expect((await post({ code: "APPWAIVE", propertyIds: [OWNED] })).status).toBe(403);
    expect(owned()).toHaveLength(0);
  });

  it("refuses properties of two different owners in one request", async () => {
    tables.account_link_invites = [seat(TEAMMATE, [OWNED]), seat(TEAMMATE, [ELSEWHERE], { inviter_user_id: OTHER })];
    asCaller(TEAMMATE);
    const res = await post({ code: "MIXED-OWN", propertyIds: [OWNED, ELSEWHERE] });
    expect(res.status).toBe(400);
    expect(tables.manager_application_fee_waiver_codes!.some((r) => r.code === "MIXED-OWN")).toBe(false);
  });

  it("refuses an id that is not a property at all", async () => {
    asCaller(TEAMMATE);
    expect((await post({ code: "GHOST-ID", propertyIds: ["no-such-property"] })).status).toBe(400);
  });

  it("admits PropLane staff by their service seat (is_service_seat) on that workspace's houses only", async () => {
    tables.account_link_invites = [
      seat(STAFF, [OWNED], { is_service_seat: true, team_role: "admin", workspace_id: "ws-service" }),
    ];
    asCaller(STAFF);
    expect((await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] })).status).toBe(200);
    expect(owned()[0]).toMatchObject({ manager_user_id: MANAGER, property_ids: [OWNED] });
    // A house of another workspace is not on the seat.
    expect((await post({ code: "OTHER-WS", propertyIds: [OWNED_3] })).status).toBe(403);
    expect(owned()).toHaveLength(1);
  });

  it("is idempotent: an active property-limited code with the same text gains this property (200)", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED] }));
    asCaller(TEAMMATE);
    const res = await post({ code: "appwaive", appliesTo: "application", propertyIds: [OWNED_2] });
    expect(res.status).toBe(200);
    expect(owned()).toHaveLength(1);
    expect(owned()[0]!.property_ids).toEqual([OWNED, OWNED_2]);
    expect(((await res.json()) as { code: { propertyIds: string[] } }).code.propertyIds).toEqual([OWNED, OWNED_2]);
  });

  it("does not widen a code that also covers houses the teammate has no edit grant on (403)", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED_3] }));
    asCaller(TEAMMATE);
    const res = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] });
    expect(res.status).toBe(403);
    expect(owned()[0]!.property_ids).toEqual([OWNED_3]);
  });

  it("the owner may widen their own code", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED_3] }));
    expect((await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] })).status).toBe(200);
    expect(owned()[0]!.property_ids).toEqual([OWNED_3, OWNED]);
  });

  it("a DELETED house still named on the code never blocks its owner", async () => {
    // `property_ids` has no foreign key, so deleting a house leaves a stale id. Re-authorizing the stored list
    // refused the owner with "Pick properties from your own portfolio" - about houses they never chose - and the
    // unique (manager, code) index blocked a fresh create too, so the code could never move again.
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED_3, "prop-deleted"] }));
    const res = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] });
    expect(res.status).toBe(200);
    expect(owned()[0]!.property_ids).toEqual([OWNED_3, "prop-deleted", OWNED]);
  });

  it("a deleted house does not block a teammate either, and grants nothing", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED, "prop-deleted"] }));
    asCaller(TEAMMATE);
    expect((await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED_2] })).status).toBe(200);
    expect(owned()[0]!.property_ids).toEqual([OWNED, "prop-deleted", OWNED_2]);
    // The house it still covers that they hold nothing on is what refuses them, exactly as before.
    tables.manager_application_fee_waiver_codes!.push(code({ code: "NOGRANT", property_ids: [OWNED_3, "prop-deleted"] }));
    expect((await post({ code: "NOGRANT", appliesTo: "application", propertyIds: [OWNED] })).status).toBe(403);
  });

  it("says the code was EXTENDED, not created, so the screen never claims a new code", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED] }));
    asCaller(TEAMMATE);
    const widened = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED_2] });
    expect(((await widened.json()) as { extended?: boolean }).extended).toBe(true);
    const already = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] });
    expect(((await already.json()) as { extended?: boolean }).extended).toBe(true);
    const fresh = await post({ code: "BRANDNEW", appliesTo: "application", propertyIds: [OWNED] });
    expect(((await fresh.json()) as { extended?: boolean }).extended).toBeUndefined();
  });

  it("refuses (409) when the request also asks for a cap, expiry or label the existing code does not have", async () => {
    const soon = new Date(Date.now() + 90 * 86_400_000).toISOString();
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE", property_ids: [OWNED], label: "Spring" }));
    asCaller(TEAMMATE);
    for (const body of [{ maxUses: 3 }, { expiresAt: soon }, { label: "Summer" }]) {
      const res = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED_2], ...body });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/Edit it from Settings/);
    }
    expect(owned()[0]).toMatchObject({ property_ids: [OWNED], max_uses: null, expires_at: null, label: "Spring" });
    // "No cap" / "never expires" / the same label ask for nothing: still extended.
    const ok = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED_2], maxUses: null, expiresAt: null, label: "Spring" });
    expect(ok.status).toBe(200);
    expect(owned()[0]!.property_ids).toEqual([OWNED, OWNED_2]);
  });

  it("returns a portfolio-wide code with the same text unchanged (200), writing nothing", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "APPWAIVE" }));
    asCaller(TEAMMATE);
    const res = await post({ code: "APPWAIVE", appliesTo: "application", propertyIds: [OWNED] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: { id: string } }).code.id).toBe("c-APPWAIVE");
    expect(owned()).toHaveLength(1);
    expect(owned()[0]!.property_ids).toBeNull();
  });

  it("a turned-off, expired or used-up code with the same text is a 409, never revived", async () => {
    asCaller(TEAMMATE);
    for (const [text, over] of [
      ["OFF-CODE", { status: "revoked" }],
      ["OLD-CODE", { expires_at: "2020-01-01T00:00:00.000Z" }],
      ["SPENT-CODE", { max_uses: 2, used_count: 2 }],
    ] as const) {
      tables.manager_application_fee_waiver_codes!.push(code({ code: text, property_ids: [OWNED], ...over }));
      const res = await post({ code: text, appliesTo: "application", propertyIds: [OWNED_2] });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/Pick a different code/);
    }
    expect(owned().find((r) => r.code === "OFF-CODE")!.status).toBe("revoked");
    expect(owned().every((r) => (r.property_ids as string[]).join() === OWNED)).toBe(true);
  });
});

describe("GET ?propertyId= lists the OWNER's codes that cover the property", () => {
  const get = (qs = "") => GET(new Request(`http://localhost/api/manager/application-fee-waivers${qs}`));
  beforeEach(() => {
    tables.manager_property_records!.push({ id: OWNED, manager_user_id: MANAGER }, { id: OWNED_3, manager_user_id: MANAGER });
    tables.account_link_invites = [seat(TEAMMATE, [OWNED])];
    tables.manager_application_fee_waiver_codes!.push(
      code({ code: "ONE-HOUSE", property_ids: [OWNED] }),
      code({ code: "OTHER-HOUSE", property_ids: [OWNED_3] }),
      code({ code: "EVERYWHERE" }),
    );
    tables.application_fee_waiver_redemptions = [];
  });

  it("a co-manager sees the covering codes, not the owner's other houses' codes", async () => {
    asCaller(TEAMMATE);
    const res = await get(`?propertyId=${OWNED}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codes: { code: string }[] };
    expect(body.codes.map((c) => c.code).sort()).toEqual(["EVERYWHERE", "ONE-HOUSE"]);
  });

  it("refuses a property the teammate holds no grant on", async () => {
    asCaller(TEAMMATE);
    expect((await get(`?propertyId=${OWNED_3}`)).status).toBe(403);
  });

  it("without a property the caller still gets only their own codes", async () => {
    asCaller(TEAMMATE);
    const body = (await (await get()).json()) as { codes: unknown[] };
    expect(body.codes).toHaveLength(0);
  });

  it("returns ONLY this property's redemptions: an applicant on another house is never disclosed", async () => {
    tables.application_fee_waiver_redemptions = [
      { id: "r-here", code_id: "c-EVERYWHERE", manager_user_id: MANAGER, property_id: OWNED, resident_email: "here@example.com", kind: "application", redeemed_at: "2026-01-01T00:00:00.000Z" },
      { id: "r-elsewhere", code_id: "c-EVERYWHERE", manager_user_id: MANAGER, property_id: OWNED_3, resident_email: "elsewhere@example.com", kind: "application", redeemed_at: "2026-01-02T00:00:00.000Z" },
      { id: "r-other-code", code_id: "c-OTHER-HOUSE", manager_user_id: MANAGER, property_id: OWNED_3, resident_email: "other@example.com", kind: "application", redeemed_at: "2026-01-03T00:00:00.000Z" },
    ];
    asCaller(TEAMMATE);
    const body = (await (await get(`?propertyId=${OWNED}`)).json()) as { redemptions: { id: string }[] };
    expect(body.redemptions.map((r) => r.id)).toEqual(["r-here"]);
    expect(JSON.stringify(body)).not.toMatch(/elsewhere@example.com|other@example.com/);
  });

  it("marks the owner's portfolio-wide code readOnly for a teammate, editable for the owner", async () => {
    asCaller(TEAMMATE);
    const asTeammate = (await (await get(`?propertyId=${OWNED}`)).json()) as { codes: { code: string; readOnly?: boolean }[] };
    // PATCH refuses a portfolio-wide code to anyone but its owner (404), so the row shows without its controls.
    expect(asTeammate.codes.find((c) => c.code === "EVERYWHERE")!.readOnly).toBe(true);
    expect(asTeammate.codes.find((c) => c.code === "ONE-HOUSE")!.readOnly).toBeUndefined();
    expect((await patch("c-EVERYWHERE", { action: "revoke" })).status).toBe(404);
    asCaller(MANAGER);
    const asOwner = (await (await get(`?propertyId=${OWNED}`)).json()) as { codes: { code: string; readOnly?: boolean }[] };
    expect(asOwner.codes.every((c) => c.readOnly === undefined)).toBe(true);
  });

  it("marks a multi-house code readOnly when the teammate holds edit on only some of its houses", async () => {
    // PATCH's gate authorizes EVERY house the code covers, so an un-flagged row offered a Disable that 403s.
    tables.manager_application_fee_waiver_codes!.push(code({ code: "BOTH-HOUSES", property_ids: [OWNED, OWNED_3] }));
    asCaller(TEAMMATE);
    const body = (await (await get(`?propertyId=${OWNED}`)).json()) as { codes: { code: string; readOnly?: boolean }[] };
    expect(body.codes.find((c) => c.code === "BOTH-HOUSES")!.readOnly).toBe(true);
    expect((await patch("c-BOTH-HOUSES", { action: "revoke" })).status).toBe(403);
  });

  it("a house that no longer exists neither flags the row nor blocks the write", async () => {
    tables.manager_application_fee_waiver_codes!.push(code({ code: "WITH-GHOST", property_ids: [OWNED, "prop-deleted"] }));
    asCaller(TEAMMATE);
    const body = (await (await get(`?propertyId=${OWNED}`)).json()) as { codes: { code: string; readOnly?: boolean }[] };
    expect(body.codes.find((c) => c.code === "WITH-GHOST")!.readOnly).toBeUndefined();
    expect((await patch("c-WITH-GHOST", { action: "revoke" })).status).toBe(200);
    expect(owned().find((r) => r.code === "WITH-GHOST")!.status).toBe("revoked");
  });

  it("an extend response carries the same readOnly stamp, so the inline row keeps its controls hidden", async () => {
    // `FormPromoCodesRow.add` merges the response straight into state: an unstamped copy put the dead ⋯ back.
    asCaller(TEAMMATE);
    const res = await post({ code: "EVERYWHERE", appliesTo: "application", propertyIds: [OWNED] });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ extended: true, code: { code: "EVERYWHERE", readOnly: true } });
    const widened = await post({ code: "ONE-HOUSE", appliesTo: "application", propertyIds: [OWNED] });
    expect(((await widened.json()) as { code: { readOnly?: boolean } }).code.readOnly).toBeUndefined();
  });
});

describe("PATCH by a teammate acts on the owner's code", () => {
  beforeEach(() => {
    tables.manager_property_records!.push({ id: OWNED, manager_user_id: MANAGER }, { id: OWNED_2, manager_user_id: MANAGER }, { id: OWNED_3, manager_user_id: MANAGER });
    tables.account_link_invites = [seat(TEAMMATE, [OWNED, OWNED_2])];
    tables.manager_application_fee_waiver_codes!.push(
      code({ code: "TWO-HOUSE", property_ids: [OWNED, OWNED_2] }),
      code({ code: "PARTLY", property_ids: [OWNED, OWNED_3] }),
      code({ code: "ALL-HOUSES" }),
    );
  });

  it("revokes a code when the teammate holds edit on every property it covers", async () => {
    asCaller(TEAMMATE);
    expect((await patch("c-TWO-HOUSE", { action: "revoke" })).status).toBe(200);
    expect(owned().find((r) => r.code === "TWO-HOUSE")!.status).toBe("revoked");
  });

  it("refuses when any covered property is outside the grant (403), and a portfolio-wide code is not theirs (404)", async () => {
    asCaller(TEAMMATE);
    expect((await patch("c-PARTLY", { action: "revoke" })).status).toBe(403);
    expect((await patch("c-ALL-HOUSES", { action: "revoke" })).status).toBe(404);
    expect(owned().filter((r) => r.status === "revoked")).toHaveLength(0);
  });

  it("an update may not move the code onto a property the teammate has no grant on", async () => {
    asCaller(TEAMMATE);
    expect((await patch("c-TWO-HOUSE", { action: "update", propertyIds: [OWNED, OWNED_3] })).status).toBe(403);
    expect((await patch("c-TWO-HOUSE", { action: "update", propertyIds: [] })).status).toBe(403);
    expect(owned().find((r) => r.code === "TWO-HOUSE")!.property_ids).toEqual([OWNED, OWNED_2]);
    expect((await patch("c-TWO-HOUSE", { action: "update", propertyIds: [OWNED], maxUses: 5 })).status).toBe(200);
    expect(owned().find((r) => r.code === "TWO-HOUSE")).toMatchObject({ property_ids: [OWNED], max_uses: 5 });
  });

  it("PropLane staff seated on the workspace can turn the owner's code off", async () => {
    tables.account_link_invites = [seat(STAFF, [OWNED, OWNED_2], { is_service_seat: true, team_role: "admin", workspace_id: "ws-service" })];
    asCaller(STAFF);
    expect((await patch("c-TWO-HOUSE", { action: "revoke" })).status).toBe(200);
  });
});


/* ----------------------------------------------------------------------------------------------------------------
 * The read-only stamp decides whether a row offers a control the write gate would then refuse. Both halves of it
 * must fail CLOSED: an answer we cannot substantiate is never permission.
 * -------------------------------------------------------------------------------------------------------------- */

describe("resolveWaiverWriteScope fails closed", () => {
  /** The real fake, except the "do these houses still exist" read reports a transient failure. */
  function dbWithFailedPropertyRead(rows: Record<string, Row[]>) {
    const real = fakeSupabaseClient(rows);
    return {
      from(table: string) {
        if (table !== "manager_property_records") return real.from(table);
        return { select: () => ({ in: async () => ({ data: null, error: { message: "connection reset" } }) }) };
      },
    };
  }

  it("marks every non-owner code read-only when the property read fails", async () => {
    // Dropping the error made `existing` empty, so every covered house read as deleted, nothing was left to
    // compare against the grant, and a code the teammate cannot write came back with a live Disable.
    tables.manager_property_records!.push({ id: OWNED, manager_user_id: MANAGER }, { id: OWNED_3, manager_user_id: MANAGER });
    tables.account_link_invites = [seat(TEAMMATE, [OWNED])];
    const db = dbWithFailedPropertyRead(tables);
    const scope = await resolveWaiverWriteScope(db as never, TEAMMATE, MANAGER, [OWNED, OWNED_3]);
    expect(scope.unavailable).toBe(true);
    expect(waiverCodeIsReadOnly({ propertyIds: [OWNED] }, scope)).toBe(true);
    expect(waiverCodeIsReadOnly({ propertyIds: [OWNED, OWNED_3] }, scope)).toBe(true);
    expect(waiverCodeIsReadOnly({ propertyIds: [] }, scope)).toBe(true);
  });

  it("still answers normally when the read succeeds", async () => {
    tables.manager_property_records!.push({ id: OWNED, manager_user_id: MANAGER }, { id: OWNED_3, manager_user_id: MANAGER });
    tables.account_link_invites = [seat(TEAMMATE, [OWNED])];
    const scope = await resolveWaiverWriteScope(fakeSupabaseClient(tables) as never, TEAMMATE, MANAGER, [OWNED, OWNED_3]);
    expect(scope.unavailable).toBe(false);
    expect(waiverCodeIsReadOnly({ propertyIds: [OWNED] }, scope)).toBe(false);
    expect(waiverCodeIsReadOnly({ propertyIds: [OWNED, OWNED_3] }, scope)).toBe(true);
  });
});
