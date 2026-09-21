import { describe, expect, it, vi } from "vitest";

import { listAgentChatThreads } from "@/lib/agent/chat-history";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function scopedDb() {
  const calls: Array<[string, string, unknown]> = [];
  const rows = [{ id: "session-a", title: "Test", updated_at: "2026-09-18T12:00:00.000Z" }];
  const messages = [{ session_id: "session-a", content: "hello" }];

  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    type Query = {
      select(value: string): Query;
      eq(key: string, value: unknown): Query;
      ilike(key: string, value: unknown): Query;
      order(): Query;
      limit(): Query;
      in(key: string, value: unknown): Query;
      lt(key: string, value: unknown): Query;
      then(resolve: (value: unknown) => unknown): Promise<unknown>;
    };
    const query: Query = {
      select(value: string) { calls.push([table, "select", value]); return query; },
      eq(key: string, value: unknown) { filters.push([key, value]); calls.push([table, "eq", [key, value]]); return query; },
      ilike(key: string, value: unknown) { filters.push([key, value]); return query; },
      order() { return query; },
      limit() { return query; },
      in(key: string, value: unknown) { filters.push([key, value]); return query; },
      lt() { return query; },
      then(resolve: (value: unknown) => unknown) {
        const source = table === "agent_sessions" ? rows : messages;
        return Promise.resolve(resolve({ data: source, error: null }));
      },
    };
    return query;
  });
  return { db: { from }, calls };
}

describe("SMS test workspace history boundary", () => {
  it("scopes history queries by workspace as well as actor, manager, mode, and session kind", async () => {
    const { db, calls } = scopedDb();
    await listAgentChatThreads(
      { userId: ACTOR, db },
      "resident",
      null,
      null,
      {
        sessionKind: "resident_sms_test:manager-a:listing-a",
        managerUserId: "manager-a",
        smsTestMode: "resident",
        workspaceId: WORKSPACE,
      } as never,
    );

    expect(calls).toContainEqual(["agent_sessions", "eq", ["user_id", ACTOR]]);
    expect(calls).toContainEqual(["agent_sessions", "eq", ["test_workspace_id", WORKSPACE]]);
  });
});
