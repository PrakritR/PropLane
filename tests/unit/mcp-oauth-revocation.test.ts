import { describe, expect, it } from "vitest";

import { revokeMcpOAuthConnection, revokeMcpOAuthToken, sha256 } from "@/lib/mcp/oauth.server";

describe("MCP OAuth revocation", () => {
  it("scopes a manager disconnect to that manager and client", async () => {
    const calls: Array<[string, unknown]> = [];
    const query = {
      update(value: unknown) { calls.push(["update", value]); return this; },
      eq(column: string, value: unknown) { calls.push([column, value]); return this; },
      is(column: string, value: unknown) { calls.push([column, value]); return this; },
      select: async () => ({ data: [{ id: "token_1" }], error: null }),
    };
    const db = { from: () => query };

    await expect(revokeMcpOAuthConnection(db as never, "manager_1", "client_1")).resolves.toBe(true);
    expect(calls).toEqual(expect.arrayContaining([["user_id", "manager_1"], ["client_id", "client_1"], ["revoked_at", null]]));
  });

  it("revokes a supplied OAuth token only within its client grant", async () => {
    const calls: Array<[string, unknown]> = [];
    const query = {
      update(value: unknown) { calls.push(["update", value]); return this; },
      eq(column: string, value: unknown) { calls.push([column, value]); return this; },
      or(value: string) { calls.push(["or", value]); return this; },
      is(column: string, value: unknown) { calls.push([column, value]); return Promise.resolve({ error: null }); },
    };
    const db = { from: () => query };

    await revokeMcpOAuthToken(db as never, { token: "pl_mcp_at_test", clientId: "client_1" });
    expect(calls).toEqual(expect.arrayContaining([["client_id", "client_1"], ["or", `access_token_sha256.eq.${sha256("pl_mcp_at_test")},refresh_token_sha256.eq.${sha256("pl_mcp_at_test")}`]]));
  });
});
