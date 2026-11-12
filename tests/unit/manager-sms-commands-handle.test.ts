import { beforeEach, describe, expect, it, vi } from "vitest";
import { world, OWNER, STAFF, STAFF_PHONE, WS } from "../helpers/manager-commands-world";

const mocks = vi.hoisted(() => ({
  phoneBelongsToActor: vi.fn(),
  buildCommandContext: vi.fn(),
  loadCommandCatalog: vi.fn(),
  proposeToolWrite: vi.fn(),
  withdrawOpenProposals: vi.fn(),
  relayReply: vi.fn(),
  nudgeReply: vi.fn(),
  filePhotos: vi.fn(),
}));

vi.mock("@/lib/manager-sms-commands/context.server", () => ({
  phoneBelongsToActor: mocks.phoneBelongsToActor,
  buildCommandContext: mocks.buildCommandContext,
}));
vi.mock("@/lib/manager-sms-commands/catalog.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-sms-commands/catalog.server")>()),
  loadCommandCatalog: mocks.loadCommandCatalog,
}));
vi.mock("@/lib/manager-sms-commands/propose.server", () => ({
  proposeToolWrite: mocks.proposeToolWrite,
  withdrawOpenProposals: mocks.withdrawOpenProposals,
}));
vi.mock("@/lib/manager-sms-commands/reply-relay.server", () => ({
  relayReply: mocks.relayReply,
  nudgeReply: mocks.nudgeReply,
  mintReplyHandleFor: vi.fn(async () => "K7"),
}));
vi.mock("@/lib/manager-sms-commands/photo-filing.server", () => ({ filePhotos: mocks.filePhotos }));

import { handleManagerSmsCommand, mintReplyHandle } from "@/lib/manager-sms-commands/index.server";
import { FIRST_QUESTION } from "@/lib/manager-sms-commands/listing-flow.server";

let w: ReturnType<typeof world>;
const PREVIEW = "Update room rent\n\nSet Room 4 at 5259 Brooklyn Ave NE to $1,150/mo.\n\nReply YES 4821 to confirm or NO to cancel.";

const cmd = (body: string, over: Record<string, unknown> = {}) =>
  handleManagerSmsCommand(w.db as never, {
    staffPhoneE164: STAFF_PHONE, actorUserId: STAFF, workspaceIds: [WS], body, messageSid: "SM-1", mediaCount: 0, onPropLaneLine: true, ...over,
  });

beforeEach(() => {
  w = world();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.phoneBelongsToActor.mockResolvedValue(true);
  mocks.buildCommandContext.mockResolvedValue(w.ctx);
  mocks.loadCommandCatalog.mockResolvedValue(w.catalog);
  mocks.proposeToolWrite.mockResolvedValue({ ok: true, reply: PREVIEW, actionId: "act-1" });
  mocks.relayReply.mockResolvedValue({ handled: false });
  mocks.nudgeReply.mockResolvedValue({ handled: false });
  mocks.filePhotos.mockResolvedValue({ handled: false });
});

describe("authorization", () => {
  it("an unverified or non-staff phone gets nothing: no reads, no writes, no reply", async () => {
    mocks.phoneBelongsToActor.mockResolvedValue(false);
    for (const body of ["change room 4 at 5259 to 1150", "new listing", "K7 yes", "5259 room 4"]) {
      expect(await cmd(body)).toEqual({ handled: false });
    }
    expect(await cmd("", { mediaCount: 3 })).toEqual({ handled: false });
    expect(mocks.loadCommandCatalog).not.toHaveBeenCalled();
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
    expect(mocks.relayReply).not.toHaveBeenCalled();
    expect(mocks.filePhotos).not.toHaveBeenCalled();
    expect(mocks.buildCommandContext).not.toHaveBeenCalled();
    expect(w.db.tables.sms_listing_flows ?? []).toHaveLength(0);
  });

  it("a phone that runs no workspace gets nothing", async () => {
    expect(await cmd("change room 4 at 5259 to 1150", { workspaceIds: [] })).toEqual({ handled: false });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("an access with no write context on the workspace is told to use PropLane, and nothing is proposed", async () => {
    mocks.buildCommandContext.mockResolvedValue(null);
    const result = await cmd("change room 4 at 5259 to 1150");
    expect(result).toMatchObject({ handled: true, reply: expect.stringContaining("in PropLane") });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("a failing command never breaks the inbound: it declines", async () => {
    mocks.loadCommandCatalog.mockRejectedValue(new Error("boom"));
    expect(await cmd("change room 4 at 5259 to 1150")).toEqual({ handled: false });
  });
});

describe("edit by text", () => {
  it("proposes the existing room-rent tool, behind the code on the PropLane line", async () => {
    const result = await cmd("change room 4 at 5259 to 1150");
    expect(result).toEqual({ handled: true, reply: PREVIEW });
    expect(mocks.proposeToolWrite).toHaveBeenCalledWith(w.db, w.ctx, {
      toolName: "update_room_rent", input: { propertyId: "prop-5259", roomName: "Room 4", rentUsd: 1150 }, requireConfirmationCode: true,
    });
  });

  it("does not demand the code on the manager's own work number (the existing plain confirmation)", async () => {
    await cmd("change room 4 at 5259 to 1150", { onPropLaneLine: false });
    expect(mocks.proposeToolWrite.mock.calls[0]![2]).toMatchObject({ requireConfirmationCode: false });
  });

  it("asks ONE line and writes nothing when the house is ambiguous", async () => {
    const result = await cmd("change room 4 at brooklyn to 1150");
    expect(result).toEqual({ handled: true, reply: "Which one: 5257 Brooklyn Ave NE or 5259 Brooklyn Ave NE?" });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("asks which house for 'price to 1200' with three houses, and which room when the house has several", async () => {
    const which = await cmd("price to 1200");
    expect(which).toEqual({ handled: true, reply: "Which one: 4709A 8th Ave NE, 5257 Brooklyn Ave NE or 5259 Brooklyn Ave NE?" });
    const room = await cmd("price at 5259 to 1200");
    expect(room).toMatchObject({ handled: true, reply: expect.stringMatching(/^Which room at 5259 Brooklyn Ave NE: Room 1, Room 2, Room 3 or Room 4\?$/) });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("proposes an availability date and a description detail through the listing-details tool", async () => {
    await cmd("5259 r4 available dec 1 2026");
    expect(mocks.proposeToolWrite.mock.calls[0]![2]).toMatchObject({ toolName: "update_listing_details", input: { propertyId: "prop-5259", roomName: "Room 4", availableOn: "2026-12-01" } });
    await cmd("description for room 9 at 4709a: sunny corner room");
    expect(mocks.proposeToolWrite.mock.calls[1]![2]).toMatchObject({
      toolName: "update_listing_details", input: { propertyId: "prop-4709a", roomName: "Room 9", detail: "sunny corner room", mode: "replace" },
    });
  });

  it("says so when the listings cannot be read", async () => {
    mocks.loadCommandCatalog.mockResolvedValue(null);
    expect(await cmd("change room 4 at 5259 to 1150")).toMatchObject({ handled: true, reply: expect.stringContaining("could not read your listings") });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("surfaces a tool's own one-line refusal", async () => {
    mocks.proposeToolWrite.mockResolvedValue({ ok: false, reply: "That listing has no room named \"Room 40\"." });
    expect(await cmd("change room 4 at 5259 to 1150")).toEqual({ handled: true, reply: "That listing has no room named \"Room 40\"." });
  });
});

describe("what is left to the manager agent", () => {
  it("bare confirmations, codes, questions and other requests", async () => {
    for (const body of ["YES 4821", "yes", "no", "what is the rent at 5259?", "remind everyone about trash day", "hello"]) {
      expect(await cmd(body)).toEqual({ handled: false });
    }
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();
  });

  it("routes a handle-shaped text to the relay and falls through when it is not one", async () => {
    mocks.relayReply.mockResolvedValueOnce({ handled: true, reply: "Sent to Maya (5259 Brooklyn Ave NE · Room 4)." });
    expect(await cmd("K7 yes Dec 1 works")).toEqual({ handled: true, reply: "Sent to Maya (5259 Brooklyn Ave NE · Room 4)." });
    expect(await cmd("Q4 something")).toEqual({ handled: false });
    expect(mocks.relayReply).toHaveBeenCalledTimes(2);
  });

  it("offers the no-handle question last", async () => {
    mocks.nudgeReply.mockResolvedValueOnce({ handled: true, reply: "Reply to Maya? Send: K7 <message>" });
    expect(await cmd("Yes Dec 1 works")).toEqual({ handled: true, reply: "Reply to Maya? Send: K7 <message>" });
  });

  it("photos go to the filing flow", async () => {
    mocks.filePhotos.mockResolvedValueOnce({ handled: true, reply: "Added 2 photos to 5259 Brooklyn Ave NE, Room 4." });
    expect(await cmd("for 5259 room 4", { mediaCount: 2 })).toEqual({ handled: true, reply: "Added 2 photos to 5259 Brooklyn Ave NE, Room 4." });
    mocks.filePhotos.mockResolvedValueOnce({ handled: false });
    expect(await cmd("", { mediaCount: 1 })).toEqual({ handled: false });
  });

  it("mintReplyHandle hands the relay's handle back to the alert builder", async () => {
    expect(await mintReplyHandle(w.db as never, { staffPhoneE164: STAFF_PHONE, workspaceId: WS, threadId: "t1", counterpartyPhoneE164: "+12065550999" })).toBe("K7");
  });
});

describe("guided create-a-listing", () => {
  const KEY = "2065550142";
  const flow = () => w.db.tables.sms_listing_flows?.find((r) => r.staff_phone_key === KEY);

  it("walks address, rooms, rent, details and proposes a DRAFT through the typed tool", async () => {
    expect(await cmd("new listing")).toEqual({ handled: true, reply: FIRST_QUESTION });
    expect(flow()).toMatchObject({ step: "address", workspace_id: WS });

    expect(await cmd("812 Pine St Seattle")).toEqual({ handled: true, reply: "How many rooms are for rent?" });
    expect(flow()).toMatchObject({ step: "rooms" });
    expect(await cmd("4")).toMatchObject({ handled: true, reply: expect.stringContaining("monthly rent") });
    expect(await cmd("$950")).toMatchObject({ handled: true, reply: expect.stringContaining("skip") });
    expect(mocks.proposeToolWrite).not.toHaveBeenCalled();

    const done = await cmd("Quiet street, two blocks from the light rail");
    expect(done).toEqual({ handled: true, reply: PREVIEW });
    const [, , call] = mocks.proposeToolWrite.mock.calls[0]!;
    expect(call).toMatchObject({
      toolName: "create_listing_draft_by_text", requireConfirmationCode: true,
      input: { address: "812 Pine St Seattle", roomCount: 4, rentsUsd: [950], details: "Quiet street, two blocks from the light rail" },
    });
    expect(call.input.flowId).toMatch(/^flow[0-9a-f]{12}$/);
    // the flow now waits for the coded confirmation, and knows which draft the photos belong to
    expect(flow()).toMatchObject({ step: "confirm" });
    expect((flow()!.draft as { draftPropertyId: string }).draftPropertyId).toMatch(/^mgr-text-[0-9a-f]{12}$/);
  });

  it("re-asks on an answer it cannot use, without advancing", async () => {
    await cmd("new listing");
    expect(await cmd("somewhere")).toMatchObject({ handled: true, reply: expect.stringContaining("street address with its number") });
    expect(flow()).toMatchObject({ step: "address" });
    await cmd("812 Pine St");
    expect(await cmd("lots")).toMatchObject({ reply: expect.stringContaining("A number from 1 to 20") });
    await cmd("3");
    expect(await cmd("nine hundred")).toMatchObject({ reply: expect.stringContaining("monthly rent in dollars") });
    expect(await cmd("900, 950")).toMatchObject({ reply: expect.stringContaining("one per room") });
    expect(flow()).toMatchObject({ step: "rent" });
  });

  it("takes one rent per room and a skipped detail", async () => {
    await cmd("create a listing at 77 Elm Ave Seattle");
    expect(flow()).toMatchObject({ step: "rooms" });
    await cmd("3");
    await cmd("900, 950, 1000");
    await cmd("skip");
    expect(mocks.proposeToolWrite.mock.calls[0]![2].input).toMatchObject({ address: "77 Elm Ave Seattle", roomCount: 3, rentsUsd: [900, 950, 1000] });
    expect(mocks.proposeToolWrite.mock.calls[0]![2].input).not.toHaveProperty("details");
  });

  it("cancel ends the flow and withdraws any open proposal", async () => {
    await cmd("new listing");
    await cmd("812 Pine St");
    expect(await cmd("cancel")).toEqual({ handled: true, reply: "Cancelled. Nothing was saved." });
    expect(flow()).toBeUndefined();
    expect(mocks.withdrawOpenProposals).toHaveBeenCalled();
  });

  it("an expired flow is ignored and the text is read normally", async () => {
    await cmd("new listing");
    flow()!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await cmd("812 Pine St")).toEqual({ handled: false });
    expect(flow()).toBeUndefined();
  });

  it("at the confirm step a code reply is the existing confirmation; NO ends the flow; anything else ends it and is read normally", async () => {
    await cmd("new listing");
    await cmd("812 Pine St");
    await cmd("2");
    await cmd("900");
    await cmd("skip");
    expect(flow()).toMatchObject({ step: "confirm" });
    expect(await cmd("YES 4821")).toEqual({ handled: false });
    expect(flow()).toMatchObject({ step: "confirm" });
    expect(await cmd("NO")).toEqual({ handled: false });
    expect(flow()).toBeUndefined();
  });

  it("photos texted at the confirm step keep the flow, so they can be filed into the new draft", async () => {
    await cmd("new listing");
    await cmd("812 Pine St");
    await cmd("2");
    await cmd("900");
    await cmd("skip");
    mocks.filePhotos.mockResolvedValueOnce({ handled: true, reply: "Added 1 photo to 812 Pine St." });
    expect(await cmd("", { mediaCount: 1 })).toEqual({ handled: true, reply: "Added 1 photo to 812 Pine St." });
    expect(flow()).toMatchObject({ step: "confirm" });
    expect(mocks.filePhotos).toHaveBeenCalledTimes(1);
  });

  it("a failed proposal ends the flow instead of leaving it stuck", async () => {
    mocks.proposeToolWrite.mockResolvedValue({ ok: false, reply: "I could not set that up just now." });
    await cmd("new listing");
    await cmd("812 Pine St");
    await cmd("2");
    await cmd("900");
    const result = await cmd("skip");
    expect(result).toMatchObject({ handled: true, reply: expect.stringContaining("new listing") });
    expect(flow()).toBeUndefined();
  });

  it("asks which workspace when the phone runs several and the text does not say", async () => {
    w = world({ portal_workspaces: [{ id: WS, name: "1. Ambika", owner_user_id: OWNER }, { id: "ws-2", name: "2. Vinod", owner_user_id: "owner-2" }] });
    mocks.buildCommandContext.mockResolvedValue(w.ctx);
    const ask = await cmd("new listing", { workspaceIds: [WS, "ws-2"] });
    expect(ask).toMatchObject({ handled: true, reply: expect.stringContaining("Which workspace") });
    expect(flow()).toBeUndefined();
    const named = await cmd("new listing for Vinod", { workspaceIds: [WS, "ws-2"] });
    expect(named).toMatchObject({ handled: true, reply: FIRST_QUESTION });
    expect(flow()).toMatchObject({ workspace_id: "ws-2" });
  });

  it("an access that cannot create a listing by text says so and starts nothing", async () => {
    mocks.buildCommandContext.mockResolvedValue(null);
    expect(await cmd("new listing")).toMatchObject({ handled: true, reply: expect.stringContaining("in PropLane") });
    expect(flow()).toBeUndefined();
  });
});
