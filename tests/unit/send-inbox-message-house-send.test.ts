/**
 * POST /api/portal/send-inbox-message for ONE copy of a "message a whole house" send (`houseSendPropertyId`):
 *   - the text is pinned to the HOUSE's workspace line and its OWNER's wallet, whoever is signed in (an owner with two
 *     workspaces, a teammate seat), never the sender's default workspace or legacy `sms_from_number`;
 *   - an unresolvable line REFUSES the text (no provider call) and the summary reads "not sent";
 *   - a wanted channel with nothing recorded reads "not sent" with the reason, never "sent";
 *   - the manager is not carbon-copied per resident;
 *   - the house is re-authorized server-side: a body id is a name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { housePersonResultLine, houseSendPayload, personResultFromResponse, type HouseRecipient } from "@/lib/house-message-recipients";

const h = vi.hoisted(() => ({
  userId: "owner-1",
  target: { ok: true } as Record<string, unknown>,
  line: { ok: true } as Record<string, unknown>,
  houseLookups: [] as Array<Record<string, unknown>>,
  lineLookups: [] as Array<Record<string, unknown>>,
  smsCalls: [] as Array<{ text?: string; mirrorToManager?: boolean; openThread: { managerUserId: string } } & Record<string, unknown>>,
  smsResult: { sent: true, sid: "SM1", channel: "twilio" } as Record<string, unknown>,
  gateWorkspaces: [] as Array<string | null | undefined>,
  recipientProfiles: [] as Array<Record<string, unknown>>,
  phones: [] as Array<Record<string, unknown>>,
  channels: { inbox: true, email: true, sms: true } as { inbox: boolean; email: boolean; sms: boolean },
  inLookups: [] as Array<{ table: string; column: string; values: readonly string[] }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: h.userId, email: `${h.userId}@example.com` } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      let selected = "";
      const chain: Record<string, unknown> = {};
      let result: unknown = null;
      for (const m of ["eq", "ilike", "order", "limit", "neq", "is", "gte", "lte", "or"]) chain[m] = () => chain;
      chain.select = (cols: string) => {
        selected = cols;
        return chain;
      };
      chain.in = (column: string, values: readonly string[]) => {
        h.inLookups.push({ table, column, values });
        if (table === "profiles") {
          if (column === "email_lower") result = selected.includes("phone") ? h.phones : h.recipientProfiles;
          else if (column === "id") result = h.recipientProfiles;
          else result = [];
        } else result = [];
        return chain;
      };
      for (const m of ["insert", "upsert", "update", "delete"]) chain[m] = () => chain;
      const single = () => {
        if (table === "profiles") return { role: "manager", full_name: "Pat Teammate", sms_from_number: null, email: `${h.userId}@example.com` };
        return null;
      };
      chain.maybeSingle = async () => ({ data: single(), error: null });
      chain.single = async () => ({ data: single(), error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: result ?? [], error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "live" }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/inbox-portal-sender", () => ({ resolveInboxSenderRoleForPortal: async () => "manager" }));
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async () => ({
    viewerId: h.userId,
    level: "edit",
    ownerIds: [h.userId],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    // The workspace the switcher shows is the DEFAULT one; the house is in another.
    activeWorkspaceId: "ws-a",
    workspaceByLine: new Map(),
  }),
}));
vi.mock("@/lib/inbox-recipient-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbox-recipient-scope")>()),
  managerMayMessageNewContacts: async () => true,
  filterRecipientsBySenderScope: async (_db: unknown, _sender: unknown, recipients: unknown[]) => ({
    allowed: recipients,
    blocked: [],
    typedNewContacts: [],
  }),
}));
vi.mock("@/lib/property-owner/access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-owner/access.server")>()),
  applyOwnerMessageInboxScope: async (_db: unknown, _who: unknown, recipients: unknown[]) => recipients,
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: async (_db: unknown, _user: unknown, workspaceId: string | null | undefined) => {
    h.gateWorkspaces.push(workspaceId);
    return { allowed: true };
  },
  assertManagerCommunicationAllowed: async () => ({ allowed: true }),
}));
vi.mock("@/lib/house-message-send.server", () => ({
  resolveHouseSendTarget: async (_db: unknown, input: Record<string, unknown>) => {
    h.houseLookups.push(input);
    return h.target;
  },
  resolveHouseSmsLine: async (_db: unknown, target: Record<string, unknown>) => {
    h.lineLookups.push(target);
    return h.line;
  },
}));
vi.mock("@/lib/notification-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notification-preferences")>()),
  resolveChannels: async () => h.channels,
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
vi.mock("@/lib/resident-outbound-sms.server", () => ({
  canSendResidentOutboundSms: (from?: string | null) => Boolean(from?.trim()),
  sendResidentOutboundSms: async (args: Record<string, unknown>) => {
    h.smsCalls.push(args);
    return h.smsResult;
  },
}));
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-delivery")>()),
  deliverPortalMessageThreadSide: async () => ({ threadId: "thread-1", action: "created" }),
}));
vi.mock("@/lib/portal-email-send.server", () => ({
  sendPortalConversationEmails: async (input: { toEmails: string[] }) =>
    new Map(input.toEmails.map((email) => [email, { sent: true, resendId: `re-${email}` }])),
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ resolveManagerOutboundFrom: async () => null }));
vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: async () => undefined }));
vi.mock("@/lib/one-number/shared-line-number.server", () => ({ resolveSharedLineHumanSend: async () => null }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));

import { POST } from "@/app/api/portal/send-inbox-message/route";

const RESIDENT = "resident@example.com";
const SEND_ID = "11111111-1111-4111-8111-111111111111";

const person: HouseRecipient = {
  id: "res-1",
  name: "Rae Resident",
  roomLabel: "Room 1",
  email: RESIDENT,
  userId: "res-1",
  propertyId: "h-b",
  guest: false,
  channels: { app: true, email: true, sms: true },
};

const via = { app: true, email: false, sms: true };
const send = (over: Record<string, unknown> = {}) =>
  POST(
    new Request("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...houseSendPayload(person, { subject: "Water off", text: "Thursday 10-1", via, senderName: "Pat", sendId: SEND_ID }),
        ...over,
      }),
    }),
  );

beforeEach(() => {
  h.userId = "owner-1";
  h.target = { ok: true, target: { propertyId: "h-b", workspaceId: "ws-b", ownerUserId: "owner-1" } };
  h.line = { ok: true, fromNumber: "+12065550222", selectedWorkLineId: "num-b", signOff: null };
  h.houseLookups = [];
  h.lineLookups = [];
  h.smsCalls = [];
  h.gateWorkspaces = [];
  h.inLookups = [];
  h.smsResult = { sent: true, sid: "SM1", channel: "twilio" };
  h.recipientProfiles = [{ id: "res-1", email: RESIDENT, role: "resident", phone: "2065550101", phone_verified_at: "2026-01-01" }];
  h.phones = [{ email: RESIDENT, phone: "2065550101" }];
  h.channels = { inbox: true, email: true, sms: true };
});

describe("a house text leaves from the HOUSE's workspace", () => {
  it("owner with two workspaces: pinned to the house's workspace line and the owner's wallet, not the default workspace's", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    // The house is resolved from the sender's own access; only the id is taken from the body.
    expect(h.houseLookups).toHaveLength(1);
    expect(h.houseLookups[0]).toMatchObject({ userId: "owner-1", propertyId: "h-b" });
    expect(h.smsCalls).toHaveLength(1);
    expect(h.smsCalls[0]).toMatchObject({
      to: "2065550101",
      fromNumber: "+12065550222",
      propertyId: "h-b",
      workspaceId: "ws-b",
      actorUserId: "owner-1",
      selectedWorkLineId: "num-b",
      recipientUserId: "res-1",
      openThread: { managerUserId: "owner-1", residentEmail: RESIDENT, topic: "general" },
    });
    // The plan gate answers to the house's workspace (ws-b), not the switcher's active one (ws-a).
    expect(h.gateWorkspaces).toEqual(["ws-b"]);
  });

  it("works with NO legacy sms_from_number on the sender: the resolved workspace line is what decides", async () => {
    // The sender profile mock carries `sms_from_number: null`; before this a house text was silently dropped here.
    const res = await send();
    const body = await res.json();
    expect(h.smsCalls).toHaveLength(1);
    expect(body.deliveries).toEqual([expect.objectContaining({ channel: "sms", status: "sent", providerId: "SM1" })]);
  });

  it("teammate seat: the OWNER is the manager of record and the wallet; the teammate is only the actor", async () => {
    h.userId = "mate-1";
    h.target = { ok: true, target: { propertyId: "h-b", workspaceId: "ws-b", ownerUserId: "owner-1" } };
    await send();
    expect(h.smsCalls).toHaveLength(1);
    expect(h.smsCalls[0]).toMatchObject({
      actorUserId: "mate-1",
      workspaceId: "ws-b",
      openThread: { managerUserId: "owner-1" },
    });
    expect(h.smsCalls[0]!.openThread.managerUserId).not.toBe("mate-1");
  });

  it("a PropLane-managed workspace's text is sent on the line the resolver answers (the PropLane line)", async () => {
    h.target = { ok: true, target: { propertyId: "h-b", workspaceId: "ws-svc", ownerUserId: "client-1" } };
    h.line = { ok: true, fromNumber: "+12066781909", selectedWorkLineId: null, signOff: null };
    await send();
    expect(h.lineLookups).toEqual([{ propertyId: "h-b", workspaceId: "ws-svc", ownerUserId: "client-1" }]);
    expect(h.smsCalls[0]).toMatchObject({ fromNumber: "+12066781909", workspaceId: "ws-svc", openThread: { managerUserId: "client-1" } });
  });

  it("on the shared line the text carries the house sign-off", async () => {
    h.line = { ok: true, fromNumber: null, selectedWorkLineId: null, signOff: "5259 Brooklyn team" };
    await send();
    expect(h.smsCalls[0]!.text).toMatch(/5259 Brooklyn team$/);
  });

  it("refuses a house the sender has no access to before anything is stored or sent", async () => {
    h.target = { ok: false, status: 404, error: "Property not found." };
    const res = await send();
    expect(res.status).toBe(404);
    expect(h.smsCalls).toHaveLength(0);
    expect(h.lineLookups).toHaveLength(0);
  });

  it("never reads the workspace or owner from the body", async () => {
    await send({ workspaceId: "ws-evil", ownerUserId: "attacker", managerUserId: "attacker" });
    expect(h.smsCalls[0]).toMatchObject({ workspaceId: "ws-b", openThread: { managerUserId: "owner-1" } });
  });
});

describe("an unresolvable line refuses the text", () => {
  beforeEach(() => {
    h.line = { ok: false, error: "workspace_has_no_work_number" };
  });

  it("sends nothing, records a failed text with the reason, and the summary reads not sent", async () => {
    const res = await send();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(h.smsCalls).toHaveLength(0);
    expect(body.deliveries).toEqual([
      expect.objectContaining({ channel: "sms", status: "failed", error: "This workspace has no work number." }),
    ]);
    const result = personResultFromResponse(person, via, { ok: res.ok, data: body });
    expect(result.sms).toBe("failed");
    expect(housePersonResultLine(result)).toBe("App ✓ · Text Not delivered (this workspace has no work number)");
    expect(housePersonResultLine(result)).not.toMatch(/Sent/);
  });

  it("an unreadable line is also a refusal, with its own plain reason", async () => {
    h.line = { ok: false, error: "control_plane_unreadable" };
    const body = await (await send()).json();
    expect(h.smsCalls).toHaveLength(0);
    expect(body.deliveries[0]).toMatchObject({ status: "failed", error: "Couldn't check the work number. Try again" });
  });
});

describe("a wanted channel with no recorded delivery is never read as sent", () => {
  it("texts off for the resident: the route says why and the summary reads Not sent", async () => {
    h.channels = { inbox: true, email: true, sms: false };
    const res = await send();
    const body = await res.json();
    expect(h.smsCalls).toHaveLength(0);
    expect(body.skipped).toEqual([{ email: RESIDENT, channel: "sms", reason: "texts_off" }]);
    const result = personResultFromResponse(person, via, { ok: res.ok, data: body });
    expect(result.sms).toBe("unsent");
    expect(housePersonResultLine(result)).toBe("App ✓ · Text Not sent (texts off)");
  });

  it("no phone on file: reason is no verified phone", async () => {
    h.channels = { inbox: true, email: true, sms: false };
    h.recipientProfiles = [{ id: "res-1", email: RESIDENT, role: "resident", phone: null, phone_verified_at: null }];
    const body = await (await send()).json();
    expect(body.skipped).toEqual([{ email: RESIDENT, channel: "sms", reason: "no_phone" }]);
    expect(housePersonResultLine(personResultFromResponse(person, via, { ok: true, data: body }))).toBe("App ✓ · Text Not sent (no verified phone)");
  });

  it("a person with no account: reason is no account", async () => {
    h.channels = { inbox: true, email: true, sms: false };
    h.recipientProfiles = [];
    const body = await (await send({ toUserIds: [] })).json();
    expect(body.skipped).toEqual([{ email: RESIDENT, channel: "sms", reason: "no_account" }]);
  });

  it("the client never reads an empty answer as sent, even from an older route that reports nothing", () => {
    const result = personResultFromResponse(person, via, { ok: true, data: { ok: true } });
    expect(result.sms).toBe("unsent");
    expect(housePersonResultLine(result)).toBe("App ✓ · Text Not sent");
  });
});

describe("no manager carbon copy on a house fan-out", () => {
  it("never mirrors each resident's text to the manager's own phone", async () => {
    await send();
    expect(h.smsCalls[0]!.mirrorToManager).toBe(false);
  });
});

describe("case-insensitive lookups", () => {
  it("reads the recipient's phone through profiles.email_lower with the lowercased address", async () => {
    h.phones = [{ email: "Resident@Example.com", phone: "2065550101" }];
    await send({ toEmails: ["Resident@Example.com"] });
    const phoneLookup = h.inLookups.find((lookup) => lookup.table === "profiles" && lookup.values.includes(RESIDENT) && lookup.column === "email_lower");
    expect(phoneLookup).toBeTruthy();
    expect(h.inLookups.filter((lookup) => lookup.table === "profiles" && lookup.column === "email")).toEqual([]);
    expect(h.smsCalls).toHaveLength(1);
  });
});
