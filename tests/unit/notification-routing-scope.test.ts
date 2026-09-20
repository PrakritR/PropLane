import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerNotificationChannels } from "@/lib/manager-notification-routing.server";

/** Minimal in-memory Supabase stub for `.select().eq().maybeSingle()` reads. */
type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        maybeSingle() {
          const match = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
          return Promise.resolve({ data: match, error: null });
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const MGR = "mgr-1";
const WORKSPACE = "workspace-1";

describe("manager notification routing honours the scope", () => {
  it("no workspace on the triggering row resolves to the account destination", async () => {
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { managerNotificationDestination: "none" } }],
      workspace_automation_settings: [
        { workspace_id: WORKSPACE, row_data: { paymentAutomation: { managerNotificationDestination: "assistant" } } },
      ],
    });

    // No workspaceId passed — exactly today's account-only behaviour.
    const channels = await resolveManagerNotificationChannels(db, MGR, "maintenance", {});
    expect(channels.inbox).toBe(false);
  });

  it("the triggering row's workspace overrides the account destination", async () => {
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { managerNotificationDestination: "none" } }],
      workspace_automation_settings: [
        { workspace_id: WORKSPACE, row_data: { paymentAutomation: { managerNotificationDestination: "assistant" } } },
      ],
    });

    const channels = await resolveManagerNotificationChannels(db, MGR, "maintenance", {}, WORKSPACE);
    expect(channels.inbox).toBe(true);
  });

  it("a workspace with no stored value falls through to the account destination", async () => {
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { managerNotificationDestination: "assistant" } }],
      workspace_automation_settings: [],
    });

    const channels = await resolveManagerNotificationChannels(db, MGR, "maintenance", {}, "some-other-workspace");
    expect(channels.inbox).toBe(true);
  });
});
