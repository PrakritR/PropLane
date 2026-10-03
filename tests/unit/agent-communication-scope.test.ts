import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S5 (comms-safety-0929): an API key, MCP connection or assistant turn has no
 * browser cookie, and `resolveCommunicationScope` used to fall back to the
 * account's FIRST workspace - so a key made for workspace B listed workspace
 * A's conversations and could not see B's. A credential-bound turn now names
 * its workspace explicitly, and with none the scope is closed.
 */

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import {
  filterVisibleInboxThreadRecords,
  resolveAgentCommunicationScope,
  resolveCommunicationScope,
} from "@/lib/communication/conversation-visibility.server";

const OWNER = "owner-1";
const WA = "ws-a";
const WB = "ws-b";

const thread = (id: string, propertyId: string) => ({
  id,
  owner_user_id: OWNER,
  participant_email: null,
  thread_type: null,
  row_data: { id, propertyId, folder: "inbox" },
});

function seed() {
  return createMemoryDb({
    profiles: [{ id: OWNER, email: "owner@example.test", role: "manager" }],
    portal_workspaces: [
      { id: WA, name: "A", owner_user_id: OWNER, is_default: true, created_at: "2026-01-01" },
      { id: WB, name: "B", owner_user_id: OWNER, is_default: false, created_at: "2026-01-02" },
    ],
    manager_property_records: [
      { id: "hA", manager_user_id: OWNER, workspace_id: WA, row_data: { buildingName: "House A" } },
      { id: "hB", manager_user_id: OWNER, workspace_id: WB, row_data: { buildingName: "House B" } },
    ],
  });
}

const rows = [thread("t-a", "hA"), thread("t-b", "hB")];
const visibleIds = async (db: ReturnType<typeof seed>, scope: Awaited<ReturnType<typeof resolveCommunicationScope>>) =>
  (await filterVisibleInboxThreadRecords(db as never, scope, rows)).map((r) => r.id).sort();

describe("resolveAgentCommunicationScope (S5)", () => {
  it("a key made for workspace B sees workspace B's conversations and not A's", async () => {
    const db = seed();
    const scope = await resolveAgentCommunicationScope({ db: db as never, userId: OWNER, workspace: { id: WB } }, "read");
    expect(await visibleIds(db, scope)).toEqual(["t-b"]);
  });

  it("a key made for workspace A sees A's", async () => {
    const db = seed();
    const scope = await resolveAgentCommunicationScope({ db: db as never, userId: OWNER, workspace: { id: WA } }, "read");
    expect(await visibleIds(db, scope)).toEqual(["t-a"]);
  });

  it("with no workspace the scope is closed, not 'the first workspace'", async () => {
    const db = seed();
    for (const workspace of [undefined, null, { id: "" }]) {
      const scope = await resolveAgentCommunicationScope({ db: db as never, userId: OWNER, workspace }, "read");
      expect(scope.closed).toBe(true);
      expect(await visibleIds(db, scope)).toEqual([]);
    }
  });

  it("a workspace the viewer does not belong to is closed too", async () => {
    const db = seed();
    const scope = await resolveAgentCommunicationScope({ db: db as never, userId: OWNER, workspace: { id: "someone-elses" } }, "read");
    expect(await visibleIds(db, scope)).toEqual([]);
  });

  it("the browser path is unchanged: no cookie still lands in the first workspace", async () => {
    const db = seed();
    const scope = await resolveCommunicationScope(db as never, OWNER, "read");
    expect(await visibleIds(db, scope)).toEqual(["t-a"]);
  });
});
