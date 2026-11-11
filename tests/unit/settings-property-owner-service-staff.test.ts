/**
 * The HOUSE rung of the manager settings routes (Automations, Reminders, Tasks): PropLane Service
 * staff reach a managed workspace's own house, and the strict co-manager gate still decides for
 * everyone else. Narrowing the Settings scope picker to one house used to 403 every staff seat.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const serviceStaffSettingsAccess = vi.fn();
vi.mock("@/lib/scope/settings-scope", () => ({
  serviceStaffSettingsAccess: (...args: unknown[]) => serviceStaffSettingsAccess(...args),
}));

// The canonical reminder-kind -> module map is loaded for real; only its two notification
// side-effect modules are stubbed, exactly as tests/unit/co-manager-notification-recipients does.
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: vi.fn(async () => ({ delivered: true, suppressed: false })) }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));

const assertCoManagerModuleAccess = vi.fn();
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: (...args: unknown[]) => assertCoManagerModuleAccess(...args),
}));

import {
  resolveSettingsPropertyOwner,
  resolveReminderKindsSettingsPropertyOwner,
} from "@/lib/auth/manager-settings-module-access.server";

const OWNER = "client-owner";
const STAFF = "staff-user";
const HOUSE = "house-1";
const WS = "ws-service";

function db(workspaceId: string | null = WS): SupabaseClient {
  return {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({
        data: { manager_user_id: OWNER, workspace_id: workspaceId },
        error: null,
      });
      return chain as never;
    },
  } as unknown as SupabaseClient;
}

const staffSeat = (over: Record<string, unknown> = {}) => ({
  kind: "ok",
  ownerUserId: OWNER,
  fullGrant: true,
  ...over,
});

beforeEach(() => {
  serviceStaffSettingsAccess.mockReset().mockResolvedValue({ kind: "none" });
  assertCoManagerModuleAccess.mockReset().mockResolvedValue({ ok: false, status: 403, error: "no" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveSettingsPropertyOwner - PropLane Service staff at the house rung", () => {
  it("a staff seat that can run the workspace acts on the OWNER's row, and the module gate is never consulted", async () => {
    serviceStaffSettingsAccess.mockResolvedValue(staffSeat());
    const result = await resolveSettingsPropertyOwner(db(), STAFF, HOUSE, "calendar", "edit");
    expect(result).toEqual({ ok: true, ownerUserId: OWNER });
    expect(serviceStaffSettingsAccess).toHaveBeenCalledWith(expect.anything(), STAFF, WS, "edit");
    expect(assertCoManagerModuleAccess).not.toHaveBeenCalled();
  });

  it("the read intent rides with the level", async () => {
    serviceStaffSettingsAccess.mockResolvedValue(staffSeat());
    await resolveSettingsPropertyOwner(db(), STAFF, HOUSE, "calendar", "read");
    expect(serviceStaffSettingsAccess).toHaveBeenCalledWith(expect.anything(), STAFF, WS, "read");
  });

  it("a seat that cannot run the workspace still answers to the strict co-manager gate", async () => {
    serviceStaffSettingsAccess.mockResolvedValue({ kind: "read_only" });
    const refused = await resolveSettingsPropertyOwner(db(), STAFF, HOUSE, "calendar", "edit");
    expect(refused).toEqual({ ok: false, status: 403, error: "no" });
    assertCoManagerModuleAccess.mockResolvedValue({ ok: true });
    const granted = await resolveSettingsPropertyOwner(db(), STAFF, HOUSE, "calendar", "edit");
    expect(granted).toEqual({ ok: true, ownerUserId: OWNER });
  });

  it("a staff match on ANOTHER owner's workspace is not this house's grant", async () => {
    serviceStaffSettingsAccess.mockResolvedValue(staffSeat({ ownerUserId: "someone-else" }));
    const result = await resolveSettingsPropertyOwner(db(), STAFF, HOUSE, "calendar", "edit");
    expect(result).toEqual({ ok: false, status: 403, error: "no" });
  });

  it("a house with no workspace never consults the staff decision", async () => {
    const result = await resolveSettingsPropertyOwner(db(null), STAFF, HOUSE, "calendar", "edit");
    expect(result).toEqual({ ok: false, status: 403, error: "no" });
    expect(serviceStaffSettingsAccess).not.toHaveBeenCalled();
  });

  it("the reminder-kinds resolver admits the same seat, and an empty kind list still fails closed", async () => {
    serviceStaffSettingsAccess.mockResolvedValue(staffSeat());
    const ok = await resolveReminderKindsSettingsPropertyOwner(db(), STAFF, HOUSE, ["payment_manager"], "edit");
    expect(ok).toEqual({ ok: true, ownerUserId: OWNER });
    const noKinds = await resolveReminderKindsSettingsPropertyOwner(db(), STAFF, HOUSE, [], "edit");
    expect(noKinds.ok).toBe(false);
  });
});
