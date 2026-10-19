// The shared line has no work-number row to place a billed turn by: the router's workspace is used, but only
// when it really is the owner's. Found by the end-to-end harness (every prospect turn was "workspace unknown").
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));

import { workspaceOwnedBy } from "@/lib/one-number/shared-line-number.server";

const db = () => createMemoryDb({ portal_workspaces: [{ id: "ws-a", owner_user_id: "owner-a", name: "A" }, { id: "ws-b", owner_user_id: "owner-b", name: "B" }] });

describe("workspaceOwnedBy", () => {
  it("returns the workspace for its owner", async () => {
    expect(await workspaceOwnedBy(db() as never, "owner-a", "ws-a")).toBe("ws-a");
  });
  it("is null for another owner's workspace, an unknown id, or nothing", async () => {
    expect(await workspaceOwnedBy(db() as never, "owner-a", "ws-b")).toBeNull();
    expect(await workspaceOwnedBy(db() as never, "owner-a", "ws-missing")).toBeNull();
    expect(await workspaceOwnedBy(db() as never, "owner-a", null)).toBeNull();
    expect(await workspaceOwnedBy(db() as never, "", "ws-a")).toBeNull();
  });
});
