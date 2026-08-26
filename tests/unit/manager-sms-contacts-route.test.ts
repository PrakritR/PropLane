import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPortalAccessContext: vi.fn(),
  fetchConversations: vi.fn(),
  resolveScope: vi.fn(),
  upsertContact: vi.fn(),
  deleteContact: vi.fn(),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.getPortalAccessContext,
  hasRole: vi.fn((_ctx, role: string) => role === "manager"),
  hasAdminRole: vi.fn(() => false),
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: mocks.fetchConversations,
  resolveSmsScopeManagerIds: mocks.resolveScope,
}));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({
  upsertManagerSmsContact: mocks.upsertContact,
  deleteManagerSmsContactName: mocks.deleteContact,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ service: true }),
}));

import { POST, PUT } from "@/app/api/manager/sms-contacts/route";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = `${OWNER}:prospect:phone:+12065552222`;

function request(conversationKey = CONVERSATION) {
  return new Request("https://prop-lane.test/api/manager/sms-contacts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationKey, displayName: "Jordan" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPortalAccessContext.mockResolvedValue({
    user: { id: VIEWER },
    roles: ["manager"],
    profile: {},
  });
  mocks.fetchConversations.mockResolvedValue({
    residents: [{
      conversationKey: CONVERSATION,
      memberKeys: [CONVERSATION],
      ownerManagerUserId: OWNER,
      phone: "+12065552222",
      counterpartyRole: "prospect",
    }],
  });
  mocks.resolveScope.mockResolvedValue([VIEWER]);
  mocks.upsertContact.mockResolvedValue({ ok: true });
});

describe("manager SMS contact authorization", () => {
  it("creates a normalized cold contact only in the authenticated manager's namespace", async () => {
    mocks.fetchConversations.mockResolvedValue({ residents: [] });

    const response = await POST(new Request("https://prop-lane.test/api/manager/sms-contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "(206) 555-2222", displayName: "Jordan" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.upsertContact).toHaveBeenCalledWith(expect.anything(), {
      managerUserId: VIEWER,
      phone: "+12065552222",
      counterpartyRole: "unknown",
      displayName: "Jordan",
    });
    const payload = await response.json();
    expect(payload.contact).toMatchObject({
      conversationKey: `${VIEWER}:unknown:+12065552222`,
      displayName: "Jordan",
      phone: "+12065552222",
      counterpartyRole: "unknown",
    });
  });

  it("renames an existing sidebar conversation for the same phone instead of creating unknown", async () => {
    mocks.resolveScope.mockResolvedValue([VIEWER, OWNER]);

    const response = await POST(new Request("https://prop-lane.test/api/manager/sms-contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+12065552222", displayName: "Akhil" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.upsertContact).toHaveBeenCalledWith(expect.anything(), {
      managerUserId: OWNER,
      phone: "+12065552222",
      counterpartyRole: "prospect",
      displayName: "Akhil",
    });
    const payload = await response.json();
    expect(payload.contact).toMatchObject({
      conversationKey: CONVERSATION,
      displayName: "Akhil",
      phone: "+12065552222",
      counterpartyRole: "prospect",
    });
  });

  it("rejects invalid cold-contact phone numbers without writing", async () => {
    const response = await POST(new Request("https://prop-lane.test/api/manager/sms-contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "555", displayName: "Jordan" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.upsertContact).not.toHaveBeenCalled();
  });

  it("does not write a label for a conversation outside the viewer's visible scope", async () => {
    const response = await PUT(request("foreign:prospect:phone:+12065559999"));

    expect(response.status).toBe(404);
    expect(mocks.upsertContact).not.toHaveBeenCalled();
  });

  it("requires Communication edit access before writing an owner's label", async () => {
    const response = await PUT(request());

    expect(response.status).toBe(403);
    expect(mocks.resolveScope).toHaveBeenCalledWith(expect.anything(), VIEWER, "edit");
    expect(mocks.upsertContact).not.toHaveBeenCalled();
  });

  it("writes only the server-resolved owner, phone and role after authorization", async () => {
    mocks.resolveScope.mockResolvedValue([VIEWER, OWNER]);

    const response = await PUT(request());

    expect(response.status).toBe(200);
    expect(mocks.upsertContact).toHaveBeenCalledWith(expect.anything(), {
      managerUserId: OWNER,
      phone: "+12065552222",
      counterpartyRole: "prospect",
      displayName: "Jordan",
    });
  });
});
