import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const scope = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: scope.fn }));

import {
  PARTNER_INQUIRIES_RECORD_ID,
  projectScheduleRecordsForViewer,
} from "@/lib/schedule-record-projection.server";

const OWNER = "owner-1";
const HOST = "co-host-1";
const PEER = "calendar-peer-1";
const STRANGER = "stranger-1";
const HOUSE = "house-1";

const inquiry = {
  id: "inq-1",
  kind: "tour",
  status: "pending",
  name: "Gabriel Guest",
  email: "gabriel@example.com",
  phone: "+12065550100",
  propertyId: HOUSE,
  propertyTitle: "5259 Brooklyn",
  roomLabel: "Room 3",
  managerUserId: OWNER,
  eligibleHostUserIds: [OWNER, HOST],
  start: "2026-11-20T18:00:00.000Z",
  end: "2026-11-20T18:30:00.000Z",
};

function db() {
  return {
    from: () => ({
      select: () => ({
        in: async () => ({ data: [{ id: HOUSE, manager_user_id: OWNER }], error: null }),
      }),
    }),
  } as never;
}

function grants(userId: string) {
  scope.fn.mockImplementation(async (_db: unknown, id: string, module: string) => {
    const has = (module === "applications" && id === HOST) || (module === "calendar" && id === PEER);
    return {
      ownerIds: new Set(),
      propertyIds: new Set(),
      propertyIdsByOwner: new Map(has ? [[OWNER, new Set([HOUSE])]] : []),
    };
  });
  return userId;
}

async function read(userId: string) {
  grants(userId);
  const out = await projectScheduleRecordsForViewer(
    db(),
    { id: userId, role: "manager" },
    [{ id: PARTNER_INQUIRIES_RECORD_ID, row_data: { payload: [inquiry] } }],
  );
  return ((out[0]?.row_data as { payload: Record<string, unknown>[] } | undefined)?.payload ?? [])[0];
}

describe("tour detail read: who gets the guest row", () => {
  beforeEach(() => scope.fn.mockReset());

  it("gives an eligible host with Applications at edit the full guest row", async () => {
    const item = await read(HOST);
    expect(item).toMatchObject({
      name: "Gabriel Guest",
      email: "gabriel@example.com",
      phone: "+12065550100",
      propertyTitle: "5259 Brooklyn",
      roomLabel: "Room 3",
    });
  });

  it("still gives the property owner the full row", async () => {
    expect((await read(OWNER))?.name).toBe("Gabriel Guest");
  });

  it("keeps a calendar-only peer on the redacted busy copy", async () => {
    const item = await read(PEER);
    expect(item).toBeDefined();
    for (const key of ["name", "email", "phone", "propertyTitle", "roomLabel"]) expect(item).not.toHaveProperty(key);
    expect(item.id).toBe("inq-1");
  });

  it("shows an unrelated manager nothing", async () => {
    expect(await read(STRANGER)).toBeUndefined();
  });
});
