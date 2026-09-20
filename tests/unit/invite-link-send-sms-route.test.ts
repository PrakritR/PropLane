/**
 * `/api/pro/invite-links/send-sms` — the body a workspace invite text carries is
 * composed on the server from the link and the workspace. The client names the
 * link; it never supplies text, so a workspace admin cannot use PropLane's work
 * number as an arbitrary SMS relay, and a link from another workspace is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  reveal: vi.fn(),
  standing: vi.fn(),
  houseIds: vi.fn(),
  linkRow: { owner_user_id: "owner-1", workspace_id: "ws-1", property_labels: ["House A", "House B"] } as Record<string, unknown>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "manager_invite_links") return { data: mocks.linkRow, error: null };
          if (table === "profiles") return { data: { full_name: "Jamie Rivera", email: "jamie@example.com" }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/workspaces/membership.server", () => ({
  actorWorkspaceStanding: mocks.standing,
  workspaceHouseIds: mocks.houseIds,
}));
vi.mock("@/lib/invite-links/invite-links.server", () => ({
  revealInviteLinkToken: mocks.reveal,
}));
vi.mock("@/lib/twilio-provisioning", () => ({
  resolveManagerWorkNumber: async () => "+12065550100",
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: mocks.send,
}));
vi.mock("@/lib/app-url", () => ({
  resolveEmailLinkBaseUrl: () => "https://proplane.test",
}));

const { POST } = await import("@/app/api/pro/invite-links/send-sms/route");

function post(body: unknown) {
  return POST(
    new Request("https://prop-lane.space/api/pro/invite-links/send-sms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ ok: true });
  mocks.standing.mockReset().mockResolvedValue({
    workspaceId: "ws-1",
    workspaceName: "Acme Portfolio",
    ownerUserId: "owner-1",
    role: "owner",
    rights: { members: true, houses: true },
    linkId: null,
  });
  mocks.houseIds.mockReset().mockResolvedValue(["house-A", "house-B", "house-C"]);
  mocks.reveal.mockReset().mockResolvedValue({
    ok: true,
    token: "tok_123",
    link: {
      id: "link-1",
      kind: "manager",
      teamRole: "leasing",
      houseScope: "selected",
      assignedPropertyIds: ["house-A", "house-B"],
      propertyPermissions: {},
      workspacePermissions: {},
    },
  });
  mocks.linkRow = { owner_user_id: "owner-1", workspace_id: "ws-1", property_labels: ["House A", "House B"] };
});

describe("POST /api/pro/invite-links/send-sms", () => {
  it("composes the text from the link and workspace — client text is ignored, never relayed", async () => {
    const res = await post({
      workspaceId: "ws-1",
      phone: "(206) 555-1212",
      linkId: "link-1",
      text: "FREE CRYPTO click here http://evil.example",
    });
    expect(res.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [args] = mocks.send.mock.calls[0] as [{ to: string; text: string; fromNumber: string }];
    expect(args.to).toBe("+12065551212");
    expect(args.fromNumber).toBe("+12065550100");
    expect(args.text).toContain("Jamie Rivera invited you to Acme Portfolio on PropLane, as Leasing over 2 of 3 houses.");
    expect(args.text).toContain("Houses: House A, House B");
    expect(args.text).toContain("Join: https://proplane.test/");
    expect(args.text).toContain("tok_123");
    expect(args.text).not.toContain("evil.example");
  });

  it("requires a link id — free-form text alone is not a send", async () => {
    const res = await post({ workspaceId: "ws-1", phone: "(206) 555-1212", text: "hello" });
    expect(res.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a link that belongs to a different workspace", async () => {
    mocks.linkRow = { owner_user_id: "owner-1", workspace_id: "ws-other", property_labels: [] };
    const res = await post({ workspaceId: "ws-1", phone: "(206) 555-1212", linkId: "link-1" });
    expect(res.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses when the actor cannot manage members of the workspace", async () => {
    mocks.standing.mockResolvedValue({
      workspaceId: "ws-1",
      workspaceName: "Acme Portfolio",
      ownerUserId: "owner-1",
      role: "viewer",
      rights: { members: false, houses: false },
      linkId: "link-own",
    });
    const res = await post({ workspaceId: "ws-1", phone: "(206) 555-1212", linkId: "link-1" });
    expect(res.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
