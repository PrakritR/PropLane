/**
 * A standalone inquiry/tour row is free-form (any manager can write one through the generic upsert), so its
 * payload house is a claim. Staff and co-managers see it only when the house's owner (or the server) wrote it
 * and the column house agrees with the payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const scope = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: scope.fn }));

import { projectScheduleRecordsForViewer } from "@/lib/schedule-record-projection.server";

const OWNER = "owner-1";
const ATTACKER = "attacker-1";
const STAFF = { id: "staff-1", role: "manager", serviceScope: { propertyIds: ["house-1"] } };
const COMANAGER = { id: "co-1", role: "manager" };
const HOUSE = "house-1";

const db = {
  from: () => ({ select: () => ({ in: async () => ({ data: [{ id: HOUSE, manager_user_id: OWNER }], error: null }) }) }),
} as never;

const row = (id: string, manager: string | null, column: string | null, payloadHouse = HOUSE) => ({
  id,
  manager_user_id: manager,
  property_id: column,
  record_type: "partner_inquiry_request",
  row_data: { id, recordType: "partner_inquiry_request", payload: { id, kind: "tour", status: "pending", propertyId: payloadHouse, name: "X" } },
});

const ids = async (user: Record<string, unknown>, rows: Record<string, unknown>[]) =>
  (await projectScheduleRecordsForViewer(db, user as never, rows)).map((r) => r.id);

beforeEach(() => {
  scope.fn.mockReset().mockImplementation(async () => ({
    ownerIds: new Set(),
    propertyIds: new Set(),
    propertyIdsByOwner: new Map([[OWNER, new Set([HOUSE])]]),
  }));
});

describe("planted standalone inquiries", () => {
  it("staff do not see a row an unrelated manager planted on a staff house", async () => {
    expect(await ids(STAFF, [row("planted", ATTACKER, HOUSE)])).toEqual([]);
  });
  it("a co-manager with a grant gets neither a full nor a busy copy of a planted row", async () => {
    expect(await ids(COMANAGER, [row("planted", ATTACKER, null)])).toEqual([]);
  });
  it("a genuine row written by the house owner (or the server) still reaches staff and the co-manager", async () => {
    expect(await ids(STAFF, [row("own", OWNER, HOUSE), row("server", null, HOUSE)])).toEqual(["own", "server"]);
    expect(await ids(COMANAGER, [row("own", OWNER, HOUSE)])).toEqual(["own"]);
  });
  it("drops a row whose column property differs from the payload house", async () => {
    expect(await ids(STAFF, [row("mismatch", OWNER, "other-house")])).toEqual([]);
  });
  it("the writer still reads their own row", async () => {
    const own = row("mine", ATTACKER, HOUSE);
    (own.row_data.payload as Record<string, unknown>).managerUserId = ATTACKER;
    expect(await ids({ id: ATTACKER, role: "manager" }, [own])).toEqual(["mine"]);
  });
});
