/**
 * Admin Communication reads the PropLane Service workspaces' texts: the service owner's PropLane-line traffic in full,
 * a client's texts ONLY when stamped with a service workspace. Another workspace of the same client is never shown, and
 * the cohort that was already there is read as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const SO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const WS_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("@/lib/claw-resident-messaging.server", () => ({ resolveMappedManagerContacts: async () => [] }));

import { fetchAdminSmsConversations, loadServiceInboxScope } from "@/lib/manager-sms-messages.server";

function inbound(id: string, owner: string, from: string, body: string, workspace: string | null) {
  return { id, manager_user_id: owner, from_phone: from, to_phone: "+12066781909", body, message_sid: `SM${id}`, matched_sender_user_id: null, counterparty_role: "prospect", conversation_key: null, created_at: "2026-10-19T20:00:00Z", workspace_id: workspace };
}

let db: ReturnType<typeof createMemoryDb>;

/** The memory client has no .range(); the resident scan pages with it, so every builder gets a no-op one. */
function withRange(base: ReturnType<typeof createMemoryDb>): ReturnType<typeof createMemoryDb> {
  return {
    ...base,
    from: (table: string) => {
      const builder = base.from(table) as unknown as Record<string, unknown>;
      builder.range = () => builder;
      return builder as never;
    },
  };
}

beforeEach(() => {
  db = createMemoryDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    portal_workspaces: [
      { id: WS_SVC, name: "1. Ambika", owner_user_id: CLIENT, is_default: true, is_service: true },
      { id: WS_OTHER, name: "Ambika personal", owner_user_id: CLIENT, is_default: false, is_service: false },
    ],
    inbound_sms_log: [
      inbound("1", SO, "+12065550101", "line prospect", null),
      inbound("2", CLIENT, "+12065550102", "service tour request", WS_SVC),
      inbound("3", CLIENT, "+12065550103", "personal workspace text", WS_OTHER),
      inbound("4", CLIENT, "+12065550104", "unstamped text", null),
    ],
    profiles: [{ id: SO, sms_from_number: "+12066781909" }],
  });
});

describe("service scope for admin Communication", () => {
  it("names the service owner, the client owners and the service workspaces only", async () => {
    expect(await loadServiceInboxScope(db as never)).toEqual({ serviceOwnerIds: [SO], clientOwnerIds: [CLIENT], workspaceIds: [WS_SVC] });
  });

  it("nothing is added when no service is configured", async () => {
    db = createMemoryDb({ platform_service_settings: [], portal_workspaces: [] });
    expect(await loadServiceInboxScope(db as never)).toEqual({ serviceOwnerIds: [], clientOwnerIds: [], workspaceIds: [] });
  });

  it("shows the PropLane line's texts and a service workspace's texts, and nothing else of the client's", async () => {
    const payload = await fetchAdminSmsConversations(withRange(db) as never);
    const bodies = payload.residents.flatMap((r) => (r as unknown as { messages?: Array<{ body: string }> }).messages ?? []).map((m) => m.body);
    expect(bodies).toContain("line prospect");
    expect(bodies).toContain("service tour request");
    expect(bodies).not.toContain("personal workspace text");
    expect(bodies).not.toContain("unstamped text");
  });
});
