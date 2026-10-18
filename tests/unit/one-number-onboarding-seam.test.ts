// The seam's onboarding hooks: a manager can run the sandbox DEMO from their own phone (and stays inside it),
// the demo's several bubbles go back as several TwiML messages, "invite" only works with the waitlist flag on,
// STOP ends a demo, and twimlOk renders one <Message> per bubble.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { fakeSharedLineDb } from "../helpers/shared-line-fake-db";

const demo = vi.hoisted(() => ({
  live: false,
  run: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, messages: ["one", "two", "three"] })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn(async () => ({ ok: true as const, messageSid: "SMout", segments: 1 })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: vi.fn(async () => ({ leadId: null, reply: null, assignedWorkspaceId: null })) }));
vi.mock("@/lib/one-number/demo/run-demo-turn.server", () => ({ runDemoTurn: (...a: unknown[]) => demo.run(...a) }));
vi.mock("@/lib/one-number/demo/store.server", () => ({ hasLiveDemo: vi.fn(async () => demo.live), endDemoForPhone: vi.fn() }));
const invite = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "Invite sent. They can skip the waitlist."));
vi.mock("@/lib/one-number/onboarding/invite.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/one-number/onboarding/invite.server")>();
  return { ...original, handleInviteCommand: (...a: unknown[]) => invite(...a) };
});

import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { twimlOk } from "@/lib/sms/inbound-pipeline.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const MGR_PHONE = "+12065550100";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550199", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };

function world() {
  return fakeSharedLineDb({
    portal_workspaces: [{ id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-a1", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" } }],
    profiles: [{ id: "owner-a", email: "a@x.com", phone: MGR_PHONE, phone_verified_at: VERIFIED }],
  });
}
const run = (db: never, body: string) => handleSharedLineInbound(db, { config, fromPhone: MGR_PHONE, body, messageSid: "SM1", mediaCount: 0, phoneKey: "2065550100" });

beforeEach(() => {
  demo.live = false;
  demo.run.mockClear();
  invite.mockClear();
});
afterEach(() => {
  delete process.env.ONE_NUMBER_WAITLIST;
});

describe("manager and the sandbox demo", () => {
  it("DEMO from a manager's phone is handled as the sandbox, in several messages, never the manager agent", async () => {
    const { db } = world();
    const result = await run(db, "DEMO");
    expect(result).toEqual({ kind: "handled", twiml: "one\n\ntwo\n\nthree", messages: ["one", "two", "three"] });
    expect(demo.run).toHaveBeenCalledWith(db, { channel: "sms", sessionKey: "2065550100", text: "DEMO" });
  });

  it("while a demo is live every manager text is the demo's", async () => {
    demo.live = true;
    const { db } = world();
    expect(await run(db, "Y")).toMatchObject({ kind: "handled" });
    expect(demo.run).toHaveBeenCalledTimes(1);
  });

  it("with no demo, a manager text continues into the real pipeline as before", async () => {
    const { db } = world();
    expect(await run(db, "who has not paid")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(demo.run).not.toHaveBeenCalled();
  });

  it("a single bubble keeps the old shape (no messages array)", async () => {
    demo.run.mockImplementationOnce(async () => ({ ok: true as const, messages: ["only"] }));
    const { db } = world();
    expect(await run(db, "DEMO")).toEqual({ kind: "handled", twiml: "only" });
  });
});

describe("invite", () => {
  it("is inert with the waitlist flag off: it goes to the manager agent", async () => {
    const { db } = world();
    expect(await run(db, "invite 206 555 0111")).toMatchObject({ kind: "continue" });
    expect(invite).not.toHaveBeenCalled();
  });

  it("with the flag on a manager's invite is answered by code", async () => {
    process.env.ONE_NUMBER_WAITLIST = "1";
    const { db } = world();
    expect(await run(db, "invite 206 555 0111")).toEqual({ kind: "handled", twiml: "Invite sent. They can skip the waitlist." });
    expect(invite).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "ws-a", ownerUserId: "owner-a", body: "invite 206 555 0111" }));
  });
});

describe("twimlOk", () => {
  it("renders one Message per bubble, escaped, and stays empty with nothing to say", async () => {
    expect(await twimlOk(["a & b", "<c>"]).text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>a &amp; b</Message><Message>&lt;c&gt;</Message></Response>');
    expect(await twimlOk("hello").text()).toContain("<Message>hello</Message>");
    expect(await twimlOk().text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(await twimlOk([]).text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
