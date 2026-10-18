import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), note: vi.fn() }));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspacePhoneText: mocks.send,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: mocks.note }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import {
  isPublicBindKind,
  lookupEntryCode,
  publicBindPhoneKey,
  requestPublicBindCode,
  verifyPublicBind,
  type EntryCode,
} from "@/lib/one-number/public-bind.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "ws-a";
const entry: EntryCode = { code: "BROOKLYN5", workspaceId: WS, ownerUserId: "owner-a", propertyId: "prop-1", label: "Brooklyn" };

function world(codes: Record<string, unknown>[] = [{ code: "BROOKLYN5", workspace_id: WS, owner_user_id: "owner-a", property_id: "prop-1", label: "Brooklyn", active: true }]) {
  return linksFakeDb({
    sms_entry_codes: codes,
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
  });
}

beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue(true);
  mocks.note.mockReset();
  mocks.note.mockResolvedValue(true);
});

describe("entry codes", () => {
  it("match case-insensitively and only while active, for a house still in the workspace", async () => {
    const { db } = world();
    expect(await lookupEntryCode(db, "brooklyn5")).toMatchObject({ code: "BROOKLYN5", workspaceId: WS, propertyId: "prop-1" });
    expect(await lookupEntryCode(db, "BrookLyn5")).not.toBeNull();
    expect(await lookupEntryCode(db, "NOPE")).toBeNull();
    expect(await lookupEntryCode(db, "bad code!")).toBeNull();
    expect(await lookupEntryCode(db, "")).toBeNull();
    expect(await lookupEntryCode(db, "a".repeat(40))).toBeNull();
    expect(await lookupEntryCode(world([{ code: "BROOKLYN5", workspace_id: WS, owner_user_id: "owner-a", property_id: "prop-1", active: false }]).db, "brooklyn5")).toBeNull();
    // The code's house moved to another workspace.
    const moved = world();
    moved.rows.manager_property_records![0]!.workspace_id = "ws-other";
    expect(await lookupEntryCode(moved.db, "brooklyn5")).toBeNull();
  });

  it("validates the kind and the typed phone", () => {
    expect(isPublicBindKind("apply")).toBe(true);
    expect(isPublicBindKind("tour")).toBe(true);
    expect(isPublicBindKind("lease")).toBe(false);
    expect(publicBindPhoneKey("(206) 555-0142")).toBe("2065550142");
    expect(publicBindPhoneKey("+1 206 555 0142")).toBe("2065550142");
    expect(publicBindPhoneKey("12345")).toBeNull();
    expect(publicBindPhoneKey("")).toBeNull();
  });
});

describe("public phone-bind", () => {
  async function sendCode(db: never, kind: "apply" | "tour" = "apply", phoneKey = "2065550142") {
    mocks.send.mockClear();
    const result = await requestPublicBindCode(db, { entry, kind, phoneKey });
    const body = (mocks.send.mock.calls[0]?.[1] as { body: string } | undefined)?.body ?? "";
    return { result, code: /\b(\d{6})\b/.exec(body)?.[1] ?? "" };
  }

  it("texts the code to the phone that was typed, from the entry code's workspace", async () => {
    const { db } = world();
    const { result, code } = await sendCode(db);
    expect(result.ok).toBe(true);
    expect(code).toMatch(/^\d{6}$/);
    expect(mocks.send.mock.calls[0]![1]).toMatchObject({ workspaceId: WS, phoneKey: "2065550142", role: "prospect" });
  });

  it("a correct code binds the phone: application link, verified session, note on the thread", async () => {
    const { db, rows } = world();
    const { code } = await sendCode(db);
    const bound = await verifyPublicBind(db, { entry, kind: "apply", phoneKey: "2065550142", code, origin: "https://proplane.test" });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const link = (await resolvePhoneBoundLink(db, bound.token, { count: false }))!.link;
    expect(link).toMatchObject({ purpose: "application", phoneKey: "2065550142", workspaceId: WS, targetType: "listing", targetId: "prop-1", requiresOtp: true });
    // The code they just entered already proved the phone: the session is open on the new link.
    expect(bound.session).not.toBeNull();
    expect(await verifyLinkSession(db, link, bound.session!.token)).toBe(true);
    expect(rows.phone_bound_links).toHaveLength(1);

    expect(mocks.note).toHaveBeenCalledTimes(1);
    expect(mocks.note.mock.calls[0]![1]).toMatchObject({
      managerUserId: "owner-a", residentPhone: "+12065550142", direction: "outbound", body: "Opened the application link", counterpartyRole: "prospect",
    });
  });

  it("a tour bind mints a tour link with no session (tours need no code)", async () => {
    const { db } = world();
    const { code } = await sendCode(db, "tour");
    const bound = await verifyPublicBind(db, { entry, kind: "tour", phoneKey: "2065550142", code });
    expect(bound.ok && bound.session).toBeNull();
    if (bound.ok) {
      const link = (await resolvePhoneBoundLink(db, bound.token, { count: false }))!.link;
      expect(link).toMatchObject({ purpose: "tour", requiresOtp: false });
    }
    expect(mocks.note.mock.calls[0]![1]).toMatchObject({ body: "Opened the tour link" });
  });

  it("a wrong code binds nothing and writes no note; five wrong codes lock it", async () => {
    const { db, rows } = world();
    const { code } = await sendCode(db);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      expect(await verifyPublicBind(db, { entry, kind: "apply", phoneKey: "2065550142", code: wrong })).toEqual({ ok: false, reason: "wrong_code" });
    }
    expect(await verifyPublicBind(db, { entry, kind: "apply", phoneKey: "2065550142", code })).toEqual({ ok: false, reason: "locked" });
    expect(rows.phone_bound_links ?? []).toHaveLength(0);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("a code for one door does not open another, or another phone's bind", async () => {
    const { db } = world();
    const { code } = await sendCode(db, "apply");
    expect(await verifyPublicBind(db, { entry, kind: "tour", phoneKey: "2065550142", code })).toEqual({ ok: false, reason: "no_challenge" });
    expect(await verifyPublicBind(db, { entry, kind: "apply", phoneKey: "2065550777", code })).toEqual({ ok: false, reason: "no_challenge" });
    expect(await verifyPublicBind(db, { entry: { ...entry, code: "OTHER" }, kind: "apply", phoneKey: "2065550142", code })).toEqual({ ok: false, reason: "no_challenge" });
  });

  it("is limited to three codes an hour per phone, and survives a failed note", async () => {
    const { db } = world();
    for (let i = 0; i < 3; i += 1) expect((await sendCode(db)).result.ok).toBe(true);
    expect((await sendCode(db)).result).toEqual({ ok: false, reason: "rate_limited" });

    const fresh = world();
    const { code } = await sendCode(fresh.db, "apply", "2065550143");
    mocks.note.mockRejectedValue(new Error("projection down"));
    const bound = await verifyPublicBind(fresh.db, { entry, kind: "apply", phoneKey: "2065550143", code });
    expect(bound.ok).toBe(true);
  });
});
