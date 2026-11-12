import { describe, expect, it, vi } from "vitest";
import { world, STAFF, STAFF_PHONE, WS, OWNER } from "../helpers/manager-commands-world";

const mocks = vi.hoisted(() => ({
  phoneBelongsToActor: vi.fn(),
  buildCommandContext: vi.fn(),
  loadCommandCatalog: vi.fn(),
  proposeToolWrite: vi.fn(),
}));
vi.mock("@/lib/manager-sms-commands/context.server", () => ({ phoneBelongsToActor: mocks.phoneBelongsToActor, buildCommandContext: mocks.buildCommandContext }));
vi.mock("@/lib/manager-sms-commands/catalog.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-sms-commands/catalog.server")>()),
  loadCommandCatalog: mocks.loadCommandCatalog,
}));
vi.mock("@/lib/manager-sms-commands/propose.server", () => ({ proposeToolWrite: mocks.proposeToolWrite, withdrawOpenProposals: vi.fn() }));

import { handleManagerSmsCommand } from "@/lib/manager-sms-commands/index.server";
import { deliverManagerCommandReply } from "@/lib/manager-sms-commands/deliver-reply.server";

const PREVIEW = "Update room rent\n\nSet Room 4 at 5259 Brooklyn Ave NE to $1,150/mo.\n\nReply YES 4821 to confirm or NO to cancel.";
const args = (text: string) => ({ managerUserId: OWNER, actorUserId: STAFF, toPhone: STAFF_PHONE, text, inboundMessageSid: "SM-9", workspaceId: WS });

describe("A4: a manager's price-change text always gets an answer they can see", () => {
  it("the real command handler produces the preview; a billing-refused send falls back to PropLane and the manager still gets it", async () => {
    const w = world();
    mocks.phoneBelongsToActor.mockResolvedValue(true);
    mocks.buildCommandContext.mockResolvedValue(w.ctx);
    mocks.loadCommandCatalog.mockResolvedValue(w.catalog);
    mocks.proposeToolWrite.mockResolvedValue({ ok: true, reply: PREVIEW, actionId: "act-1" });
    const command = await handleManagerSmsCommand(w.db as never, {
      staffPhoneE164: STAFF_PHONE, actorUserId: STAFF, workspaceIds: [WS], body: "change room 4 at 5259 to 1150", messageSid: "SM-9", mediaCount: 0, onPropLaneLine: true,
    });
    expect(command).toMatchObject({ handled: true, reply: PREVIEW });
    if (!command.handled) return;
    const deliver = vi.fn(async () => ({ ok: false, error: "comms_billing_allowance_exhausted" }));
    const fallback = vi.fn(async () => ({ attempted: true, ok: true }));
    const notify = vi.fn();
    const out = await deliverManagerCommandReply(w.db as never, args(command.reply), { deliver, fallback, notify });
    expect(out).toEqual({ delivered: true, via: "proplane" });
    expect(fallback).toHaveBeenCalledWith(w.db, expect.objectContaining({ refusalCode: "comms_billing_allowance_exhausted", body: PREVIEW, claimKey: "manager-command:SM-9" }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("a reply that cannot be texted at all lands in the manager's Assistant with the reason and the answer", async () => {
    const notify = vi.fn(async () => undefined);
    const out = await deliverManagerCommandReply({} as never, args(PREVIEW), {
      deliver: async () => ({ ok: false, error: "comms_billing_allowance_exhausted" }),
      fallback: async () => ({ attempted: true, ok: false, reason: "not_shared_mode" }),
      notify,
    });
    expect(out).toEqual({ delivered: true, via: "assistant" });
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      landlordId: STAFF, senderOwnerId: OWNER, idempotencyKey: "manager-command-reply:SM-9",
      text: expect.stringContaining(PREVIEW),
    }));
    expect(notify.mock.calls[0]![1].text).toContain("text credit");
  });

  it("a non-wallet refusal never uses the PropLane line but is still shown; a delivered reply does nothing extra", async () => {
    const fallback = vi.fn();
    const notify = vi.fn(async () => undefined);
    await deliverManagerCommandReply({} as never, args("x"), { deliver: async () => ({ ok: false, error: "recipient_opted_out" }), fallback, notify });
    expect(fallback).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const notify2 = vi.fn();
    expect(await deliverManagerCommandReply({} as never, args("x"), { deliver: async () => ({ ok: true }), fallback, notify: notify2 })).toEqual({ delivered: true, via: "line" });
    expect(notify2).not.toHaveBeenCalled();
  });

  it("a send that throws is treated as a refusal, never swallowed", async () => {
    const notify = vi.fn(async () => undefined);
    const out = await deliverManagerCommandReply({} as never, args("x"), { deliver: async () => { throw new Error("x"); }, fallback: vi.fn(), notify });
    expect(out.via).toBe("assistant");
  });
});
