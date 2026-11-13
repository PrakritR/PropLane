// POST /api/public/listing-message (design-1112 §1): a signed-out visitor messages a home or one room with a phone and a
// texted code; the message goes through the prospect spine as a VERIFIED phone identity, exactly as typed; no account is
// created; nothing reveals whether the phone is known.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
const limits = vi.hoisted(() => ({ deny: [] as string[], keys: [] as string[] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async (key: string) => {
    limits.keys.push(key);
    return { ok: !limits.deny.some((d) => key.startsWith(d)) };
  }),
  clientIpFrom: () => "203.0.113.9",
}));
const texts = vi.hoisted(() => ({ sent: [] as { phoneKey: string; body: string; workspaceId: string }[], ok: true }));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspacePhoneText: vi.fn(async (_db: unknown, input: { phoneKey: string; body: string; workspaceId: string }) => {
    texts.sent.push(input);
    return texts.ok;
  }),
}));
const spine = vi.hoisted(() => ({ recordInbound: vi.fn() }));
vi.mock("@/lib/prospect-spine/index.server", () => ({ recordInbound: spine.recordInbound }));
const consent = vi.hoisted(() => ({ optIn: vi.fn(async () => undefined) }));
vi.mock("@/lib/sms-consent", async (orig) => ({ ...(await orig<typeof import("@/lib/sms-consent")>()), recordOptIn: consent.optIn }));
const phoneAuth = vi.hoisted(() => ({ identity: vi.fn(), owners: vi.fn(async () => ["someone"]) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ readPhoneIdentity: phoneAuth.identity, phoneOwners: phoneAuth.owners }));
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: session.user } }) } }),
}));
const serviceDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb.db }));
const texting = vi.hoisted(() => ({ phone: "+12066781909" as string | null }));
vi.mock("@/lib/marketing/public-texting.server", () => ({ getPublicTextingConfig: async () => ({ phone: texting.phone, smsHref: null }) }));

import { GET, POST } from "@/app/api/public/listing-message/route";
import { linksFakeDb, type LinksFakeDb } from "../helpers/links-fake-db";

const WS = "11111111-1111-1111-1111-111111111111";
const PHONE = "(206) 555-0142";
const E164 = "+12065550142";

let fake: LinksFakeDb;
let authCalls: string[];

function listing(over: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    manager_user_id: "owner-1",
    workspace_id: WS,
    status: "live",
    test_workspace_id: null,
    property_data: {
      title: "5259 Brooklyn",
      buildingName: "5259 Brooklyn",
      address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
      listingSubmission: { v: 1, rooms: [{ id: "r4", name: "Room 4" }, { id: "r5", name: "Room 5" }] },
    },
    ...over,
  };
}

beforeEach(() => {
  fake = linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-1", is_default: true }],
    manager_property_records: [listing()],
  });
  authCalls = [];
  (fake.db as unknown as { auth: unknown }).auth = {
    admin: new Proxy({}, { get: (_t, name) => (..._a: unknown[]) => { authCalls.push(String(name)); throw new Error("no account may be touched"); } }),
  };
  serviceDb.db = fake.db;
  limits.deny = [];
  limits.keys = [];
  texts.sent = [];
  texts.ok = true;
  texting.phone = "+12066781909";
  session.user = null;
  spine.recordInbound.mockReset().mockResolvedValue({ ok: true, threadId: "t1", messageId: "m1", contextId: "c1", created: true, duplicate: false, label: "5259 Brooklyn · Room 4" });
  consent.optIn.mockClear();
  phoneAuth.identity.mockReset();
  phoneAuth.owners.mockClear();
});

const post = (body: Record<string, unknown>) =>
  POST(new Request("https://proplane.test/api/public/listing-message", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const codeSent = () => /\b(\d{6})\b/.exec(texts.sent.at(-1)?.body ?? "")?.[1] ?? "";
const base = { propertyId: "prop-1", roomId: "r4", phone: PHONE, body: "Is the room still open for Dec 1?" };

describe("send_code", () => {
  it("texts a six-digit code to the typed phone from the home's workspace, and stores nothing yet", async () => {
    const res = await post({ action: "send_code", ...base });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(texts.sent).toHaveLength(1);
    expect(texts.sent[0]).toMatchObject({ phoneKey: "2065550142", workspaceId: WS });
    expect(codeSent()).toMatch(/^\d{6}$/);
    expect(spine.recordInbound).not.toHaveBeenCalled();
  });

  it("is rate limited by IP, by phone and by property, before any text goes out", async () => {
    for (const prefix of ["listing-message-send-ip:", "listing-message-send-phone:", "listing-message-send-property:"]) {
      limits.deny = [prefix];
      texts.sent = [];
      const res = await post({ action: "send_code", ...base });
      expect(res.status).toBe(429);
      expect(texts.sent).toHaveLength(0);
    }
  });

  it("rejects a bad phone, an unknown or unpublished listing, and a room that is not on the listing", async () => {
    expect((await post({ action: "send_code", ...base, phone: "12" })).status).toBe(400);
    expect((await post({ action: "send_code", ...base, propertyId: "nope" })).status).toBe(404);
    fake.rows.manager_property_records![0]!.status = "draft";
    expect((await post({ action: "send_code", ...base })).status).toBe(404);
    fake.rows.manager_property_records![0]!.status = "live";
    const room = await post({ action: "send_code", ...base, roomId: "r99" });
    expect(room.status).toBe(400);
    expect(await room.json()).toEqual({ error: "That room is not on this listing." });
    expect(texts.sent).toHaveLength(0);
  });

  it("a text that cannot be sent is a generic error, not a reason", async () => {
    texts.ok = false;
    const res = await post({ action: "send_code", ...base });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "We could not text that number. Check it and try again." });
  });

  it("answers identically whether or not the phone already has an account, and never looks one up", async () => {
    phoneAuth.owners.mockResolvedValue(["someone"]);
    const known = await (await post({ action: "send_code", ...base })).json();
    phoneAuth.owners.mockResolvedValue([]);
    const unknown = await (await post({ action: "send_code", ...base, phone: "(206) 555-0199" })).json();
    expect(known).toEqual(unknown);
    expect(phoneAuth.owners).not.toHaveBeenCalled();
  });
});

describe("verify_send", () => {
  it("a wrong or missing code stores nothing and creates no account", async () => {
    await post({ action: "send_code", ...base });
    const wrong = await post({ action: "verify_send", ...base, otp: "000000" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "That code did not work." });
    expect((await post({ action: "verify_send", ...base })).status).toBe(400);
    expect(spine.recordInbound).not.toHaveBeenCalled();
    expect(authCalls).toEqual([]);
  });

  it("the right code stores the message exactly as typed through the spine as a VERIFIED phone, with the room as the stamp", async () => {
    await post({ action: "send_code", ...base });
    const res = await post({ action: "verify_send", ...base, name: "Maya", otp: codeSent(), workspaceId: "evil-ws", ownerUserId: "evil-owner" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; accountUrl?: string };
    expect(json.ok).toBe(true);
    expect(json.accountUrl).toMatch(/\/l\/[A-Za-z0-9_-]{32,}$/);
    expect(spine.recordInbound).toHaveBeenCalledTimes(1);
    const input = spine.recordInbound.mock.calls[0]![1];
    expect(input).toMatchObject({
      workspaceId: WS,
      ownerUserId: "owner-1",
      identity: { kind: "phone", phoneE164: E164, verified: true, displayName: "Maya" },
      context: { propertyId: "prop-1", roomId: "r4", roomLabel: "Room 4", source: "listing_message" },
      body: "Is the room still open for Dec 1?",
      channel: "in_app",
    });
    expect(input.eventId).toMatch(/^web:/);
    expect(input.body).not.toMatch(/Brooklyn|Room 4/);
    expect(consent.optIn).toHaveBeenCalledWith(expect.anything(), "2065550142", null, "listing-message");
    expect(authCalls).toEqual([]);
    // The personal link is bound to this phone and workspace, for this home.
    const link = fake.rows.phone_bound_links!.at(-1)!;
    expect(link).toMatchObject({ purpose: "account", phone_key: "2065550142", workspace_id: WS, requires_otp: false });
  });

  it("the code is single use and bound to this home", async () => {
    await post({ action: "send_code", ...base });
    const code = codeSent();
    expect((await post({ action: "verify_send", ...base, otp: code })).status).toBe(200);
    expect((await post({ action: "verify_send", ...base, otp: code })).status).toBe(400);
    await post({ action: "send_code", ...base });
    fake.rows.manager_property_records!.push(listing({ id: "prop-2" }));
    expect((await post({ action: "verify_send", ...base, propertyId: "prop-2", otp: codeSent() })).status).toBe(400);
  });

  it("a house-level message has no room stamp", async () => {
    await post({ action: "send_code", ...base, roomId: undefined });
    await post({ action: "verify_send", ...base, roomId: undefined, otp: codeSent() });
    expect(spine.recordInbound.mock.calls[0]![1].context).toMatchObject({ propertyId: "prop-1", roomId: null, roomLabel: null });
  });

  it("when the spine cannot store it, the visitor is told to ask for a new code (the old one is spent)", async () => {
    spine.recordInbound.mockResolvedValue({ ok: false, reason: "store_unavailable" });
    await post({ action: "send_code", ...base });
    const res = await post({ action: "verify_send", ...base, otp: codeSent() });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ needsNewCode: true });
    expect(fake.rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("a signed-in visitor whose verified phone is the one typed skips the code; any other phone still needs one", async () => {
    session.user = { id: "u1" };
    phoneAuth.identity.mockResolvedValue({ phone: E164, verified: true });
    const skip = await post({ action: "send_code", ...base });
    expect(await skip.json()).toEqual({ ok: true, skipCode: true });
    expect(texts.sent).toHaveLength(0);
    expect((await post({ action: "verify_send", ...base })).status).toBe(200);
    expect(spine.recordInbound.mock.calls[0]![1].identity).toMatchObject({ verified: true, phoneE164: E164 });
    const other = await post({ action: "verify_send", ...base, phone: "(206) 555-0177" });
    expect(other.status).toBe(400);
    phoneAuth.identity.mockResolvedValue({ phone: E164, verified: false });
    expect((await post({ action: "verify_send", ...base })).status).toBe(400);
  });

  it("is rate limited per IP and per phone", async () => {
    for (const prefix of ["listing-message-verify-ip:", "listing-message-verify-phone:"]) {
      limits.deny = [prefix];
      expect((await post({ action: "verify_send", ...base, otp: "123456" })).status).toBe(429);
    }
    expect(spine.recordInbound).not.toHaveBeenCalled();
  });
});

describe("the request shape", () => {
  it("needs a message and a known action, and keeps nothing but ids from the body", async () => {
    expect((await post({ action: "send_code", ...base, body: "  " })).status).toBe(400);
    expect((await post({ action: "delete_all", ...base })).status).toBe(400);
    const bad = await POST(new Request("https://proplane.test/x", { method: "POST", body: "not json" }));
    expect(bad.status).toBe(400);
  });
});

describe("GET ?propertyId= (the Text us entry code)", () => {
  const get = (id: string) => GET(new Request(`https://proplane.test/api/public/listing-message?propertyId=${id}`));

  it("returns the home's active entry code, creating one once when it has none, and is CDN-cacheable", async () => {
    const first = await get("prop-1");
    expect(first.headers.get("Cache-Control")).toContain("s-maxage");
    const { textCode } = (await first.json()) as { textCode: string };
    expect(textCode).toMatch(/^[A-Z0-9]{3,16}$/);
    const second = await (await get("prop-1")).json();
    expect(second).toEqual({ textCode });
    expect(fake.rows.sms_entry_codes).toHaveLength(1);
    expect(fake.rows.sms_entry_codes![0]).toMatchObject({ workspace_id: WS, property_id: "prop-1", owner_user_id: "owner-1" });
  });

  it("prefers a code the manager already holds", async () => {
    fake.rows.sms_entry_codes = [{ code: "BROOKLYN", workspace_id: WS, property_id: "prop-1", active: true, label: "x", created_at: "2026-01-01" }];
    expect(await (await get("prop-1")).json()).toEqual({ textCode: "BROOKLYN" });
    expect(fake.rows.sms_entry_codes).toHaveLength(1);
  });

  it("is null, and writes nothing, with no configured number or for a home that is not live", async () => {
    texting.phone = null;
    expect(await (await get("prop-1")).json()).toEqual({ textCode: null });
    texting.phone = "+12066781909";
    expect(await (await get("nope")).json()).toEqual({ textCode: null });
    expect(fake.rows.sms_entry_codes ?? []).toHaveLength(0);
  });
});
