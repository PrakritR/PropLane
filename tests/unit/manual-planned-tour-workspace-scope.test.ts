import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * W011: `createManualPlannedTour` (`managerCanScheduleTourOnProperty`)
 * authorized strictly by ownership/co-manager grant, never the caller's
 * active workspace — an owner with Workspace A active could still schedule a
 * manual tour against a property in their own Workspace B. The
 * `portal-schedule-records` route's own create path already enforced this;
 * this manual-tour path did not.
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined, isAdmin: false }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));

const mocks = vi.hoisted(() => ({
  loadWorkspaces: vi.fn(),
  getShareablePropertyForUser: vi.fn(async () => null),
  isAdminUser: vi.fn(async () => false),
  syncPlannedTourToGoogleCalendar: vi.fn(async () => undefined),
  mutateConfirmedTourSchedule: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));
vi.mock("@/lib/manager-property-share-access", () => ({ getShareablePropertyForUser: mocks.getShareablePropertyForUser }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: mocks.isAdminUser }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncPlannedTourToGoogleCalendar: mocks.syncPlannedTourToGoogleCalendar }));
vi.mock("@/lib/tour-schedule-persistence.server", () => ({ mutateConfirmedTourSchedule: mocks.mutateConfirmedTourSchedule }));

import { createManualPlannedTour } from "@/lib/manual-planned-tour.server";

const MANAGER = "mgr-1";
const WS_A = { id: "ws-a", name: "A", ownerUserId: MANAGER, owned: true, isDefault: true, propertyIds: ["p1"] };
const WS_B = { id: "ws-b", name: "B", ownerUserId: MANAGER, owned: true, isDefault: false, propertyIds: ["p2"] };

function setup(rows: { manager_property_records?: Row[]; portal_schedule_records?: Row[]; account_link_invites?: Row[] } = {}) {
  return fakeSupabaseClient({
    manager_property_records: rows.manager_property_records ?? [
      { id: "p1", manager_user_id: MANAGER, property_data: { address: "1 Main St" } },
      { id: "p2", manager_user_id: MANAGER, property_data: { address: "2 Main St" } },
    ],
    portal_schedule_records: rows.portal_schedule_records ?? [],
    account_link_invites: rows.account_link_invites ?? [],
  });
}

function input(propertyId: string) {
  return {
    propertyId,
    guestName: "Jamie Guest",
    start: "2026-10-01T18:00:00.000Z",
    end: "2026-10-01T18:30:00.000Z",
  };
}

beforeEach(() => {
  state.cookieValue = undefined;
  mocks.loadWorkspaces.mockReset();
  mocks.getShareablePropertyForUser.mockReset().mockResolvedValue(null);
  mocks.isAdminUser.mockReset().mockResolvedValue(false);
  mocks.syncPlannedTourToGoogleCalendar.mockReset().mockResolvedValue(undefined);
  mocks.mutateConfirmedTourSchedule.mockReset().mockResolvedValue({ ok: true });
});

describe("createManualPlannedTour — active-workspace guard", () => {
  it("refuses a manual tour for a property outside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id; // active = p1 only
    const db = setup();
    const result = await createManualPlannedTour(db as never, MANAGER, input("p2"));
    expect(result).toMatchObject({ ok: false, status: 403, error: expect.stringMatching(/active workspace/) });
  });

  it("allows a manual tour for a property inside the active workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup();
    const result = await createManualPlannedTour(db as never, MANAGER, input("p1"));
    expect(result.ok).toBe(true);
  });

  it("switching the active workspace to B allows p2 and now refuses p1", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_B.id;
    const db = setup();
    const allowed = await createManualPlannedTour(db as never, MANAGER, input("p2"));
    expect(allowed.ok).toBe(true);
    const refused = await createManualPlannedTour(db as never, MANAGER, input("p1"));
    expect(refused).toMatchObject({ ok: false, status: 403 });
  });

  it("an admin bypasses workspace narrowing entirely", async () => {
    mocks.isAdminUser.mockResolvedValue(true);
    mocks.loadWorkspaces.mockResolvedValue([WS_A, WS_B]);
    state.cookieValue = WS_A.id;
    const db = setup();
    const result = await createManualPlannedTour(db as never, MANAGER, input("p2"));
    expect(result.ok).toBe(true);
    expect(mocks.loadWorkspaces).not.toHaveBeenCalled();
  });

  it("a single-workspace manager is unaffected", async () => {
    mocks.loadWorkspaces.mockResolvedValue([WS_A]);
    const db = setup();
    const result = await createManualPlannedTour(db as never, MANAGER, input("p1"));
    expect(result.ok).toBe(true);
  });
});
