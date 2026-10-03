import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/** S6 (email half): mail leaves from the workspace whose address the conversation used. */
const resolveWorkspaceWorkEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveWorkspaceWorkEmail }));

import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";

const db = () =>
  createMemoryDb({
    profiles: [{ id: "owner-1", full_name: "Jane Owner" }],
    portal_workspaces: [
      { id: "ws-a", owner_user_id: "owner-1" },
      { id: "ws-b", owner_user_id: "owner-1" },
    ],
    manager_assistant_emails: [
      { workspace_id: "ws-a", inbox_token: "tokA", mailbox_local: "alpha" },
      { workspace_id: "ws-b", inbox_token: "tokB", mailbox_local: "beta" },
    ],
  }) as never;

beforeEach(() => {
  process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
  resolveWorkspaceWorkEmail.mockReset();
  resolveWorkspaceWorkEmail.mockImplementation(async (_db: unknown, _id: string, ws?: string | null) => ({
    address: ws === "ws-b" ? "beta@prop-lane.space" : "alpha@prop-lane.space",
  }));
});

describe("resolveManagerOutboundFrom workLine (S6)", () => {
  it("a conversation that used workspace B's address replies from B", async () => {
    const from = await resolveManagerOutboundFrom(db(), "owner-1", { workLine: "beta@prop-lane.space" });
    expect(resolveWorkspaceWorkEmail).toHaveBeenCalledWith(expect.anything(), "owner-1", "ws-b");
    expect(from).toBe("Jane Owner <beta@prop-lane.space>");
  });

  it("an address that matches none of the owner's workspaces gets the shared sender, never another workspace's", async () => {
    expect(await resolveManagerOutboundFrom(db(), "owner-1", { workLine: "stranger@prop-lane.space" })).toBeNull();
    expect(resolveWorkspaceWorkEmail).not.toHaveBeenCalled();
  });
});
