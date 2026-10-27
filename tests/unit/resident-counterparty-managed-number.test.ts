import { describe, expect, it } from "vitest";
import { makeServiceFakeDb } from "../helpers/service-fake-db";
import { loadResidentCounterparties } from "@/lib/communication/resident-conversations.server";

/**
 * A1: the number a resident sees in a conversation header goes through the managed-aware resolver. A PropLane-managed
 * workspace shows the PropLane line (206), never the number it once held; an ordinary workspace shows its own.
 */

const MANAGED_WS = "11111111-1111-4111-8111-111111111111";
const NORMAL_WS = "22222222-2222-4222-8222-222222222222";
const SERVICE_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seed(config: Record<string, unknown>[]) {
  return makeServiceFakeDb({
    portal_workspaces: [
      { id: MANAGED_WS, name: "Ambika Homes", owner_user_id: SERVICE_OWNER, is_service: true, is_default: false },
      { id: NORMAL_WS, name: "Marcus Homes", owner_user_id: OTHER_OWNER, is_service: false, is_default: true },
    ],
    profiles: [
      { id: SERVICE_OWNER, full_name: "Ambika Magos" },
      { id: OTHER_OWNER, full_name: "Marcus Hill" },
    ],
    manager_sms_numbers: [
      { workspace_id: MANAGED_WS, manager_user_id: SERVICE_OWNER, phone_number: "+18146793694", provision_state: "active", released_at: null },
      { workspace_id: NORMAL_WS, manager_user_id: OTHER_OWNER, phone_number: "+14255550100", provision_state: "active", released_at: null },
    ],
    platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
    sms_runtime_config: config,
  });
}

const shared = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12066781909", shared_pilot_workspace_ids: [] }];

describe("resident conversation header number", () => {
  it("shows the 206 for a managed workspace and the workspace's own number for a normal one", async () => {
    const db = seed(shared);
    const out = await loadResidentCounterparties(db as never, [MANAGED_WS, NORMAL_WS]);
    expect(out.get(MANAGED_WS)).toMatchObject({ workPhone: "+12066781909", onPropLaneLine: true });
    expect(out.get(NORMAL_WS)).toMatchObject({ workPhone: "+14255550100" });
    expect(out.get(NORMAL_WS)).not.toHaveProperty("onPropLaneLine");
  });

  it("never falls back to the old number when the PropLane line cannot be resolved", async () => {
    const db = seed([]);
    const out = await loadResidentCounterparties(db as never, [MANAGED_WS, NORMAL_WS]);
    expect(out.get(MANAGED_WS)?.workPhone).toBeNull();
    expect(out.get(NORMAL_WS)?.workPhone).toBe("+14255550100");
  });

  it("exposes no number at all when the managed (is_service) read fails: unknown is not unmanaged", async () => {
    const real = seed(shared);
    const db = {
      ...real,
      from: (table: string) => {
        const builder = (real as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        if (table !== "portal_workspaces") return builder;
        return {
          ...builder,
          select: (columns: string, ...rest: unknown[]) =>
            columns.includes("is_service")
              ? { in: async () => ({ data: null, error: { code: "XX000", message: "boom" } }) }
              : (builder.select as (...a: unknown[]) => unknown)(columns, ...rest),
        };
      },
    };
    const out = await loadResidentCounterparties(db as never, [MANAGED_WS, NORMAL_WS]);
    for (const ws of [MANAGED_WS, NORMAL_WS]) {
      expect(out.get(ws)?.workPhone).toBeNull();
      expect(out.get(ws)).not.toHaveProperty("onPropLaneLine");
    }
    expect(JSON.stringify([...out.values()])).not.toMatch(/8146793694|4255550100/);
  });
});
