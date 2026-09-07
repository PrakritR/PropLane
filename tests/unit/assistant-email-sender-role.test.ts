/**
 * Which assistant answers a manager's work email.
 *
 * The ordering IS the security property, so each rule is asserted on its own:
 * a manager is never demoted to a resident, a resident is never answered from
 * the public catalog, and a lookup failure widens nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManagerEmailInboundIdentity: vi.fn(),
  resolveResidentInboxAgentContext: vi.fn(),
}));

vi.mock("@/lib/manager-assistant-email/manager-email-access.server", () => ({
  resolveManagerEmailInboundIdentity: mocks.resolveManagerEmailInboundIdentity,
}));

vi.mock("@/lib/tools/resident-inbox-context", () => ({
  resolveResidentInboxAgentContext: mocks.resolveResidentInboxAgentContext,
}));

import { classifyAssistantEmailSender } from "@/lib/manager-assistant-email/assistant-email-sender-role.server";

const db = {} as unknown as import("@supabase/supabase-js").SupabaseClient;
const MANAGER = "mgr-1";

const managerIdentity = {
  workNumberOwnerId: MANAGER,
  actorUserId: MANAGER,
  actorEmail: "mgr@example.com",
  access: { mode: "owner" },
};
const residentCtx = { kind: "resident", userId: "res-1", email: "res@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
  mocks.resolveResidentInboxAgentContext.mockResolvedValue({ ok: false, reason: "not_a_resident" });
});

describe("classifyAssistantEmailSender", () => {
  it("routes the mailbox owner to the manager assistant", async () => {
    mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(managerIdentity);
    const sender = await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "mgr@example.com",
    });
    expect(sender).toEqual({ role: "manager", identity: managerIdentity });
    // Manager wins outright — the resident lookup is not even reached.
    expect(mocks.resolveResidentInboxAgentContext).not.toHaveBeenCalled();
  });

  it("routes a current resident of this manager to the resident assistant", async () => {
    mocks.resolveResidentInboxAgentContext.mockResolvedValue({ ok: true, ctx: residentCtx });
    const sender = await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "res@example.com",
    });
    expect(sender).toEqual({ role: "resident", ctx: residentCtx });
  });

  it("scopes the resident lookup to the mailbox owner", async () => {
    await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "res@example.com",
    });
    // A resident of some OTHER manager must not gain resident scope here.
    expect(mocks.resolveResidentInboxAgentContext).toHaveBeenCalledWith(db, {
      residentEmail: "res@example.com",
      ownerManagerUserId: MANAGER,
    });
  });

  it("routes a stranger to the public leasing assistant", async () => {
    const sender = await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "someone@example.com",
    });
    expect(sender).toEqual({ role: "prospect" });
  });

  it("falls to the least privileged role when the resident lookup fails", async () => {
    mocks.resolveResidentInboxAgentContext.mockResolvedValue({ ok: false, reason: "lookup_failed" });
    const sender = await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "res@example.com",
    });
    expect(sender).toEqual({ role: "prospect" });
  });

  it("normalizes the sender address before matching", async () => {
    mocks.resolveResidentInboxAgentContext.mockResolvedValue({ ok: true, ctx: residentCtx });
    await classifyAssistantEmailSender(db, {
      managerUserId: MANAGER,
      fromEmail: "  RES@Example.COM ",
    });
    expect(mocks.resolveResidentInboxAgentContext).toHaveBeenCalledWith(db, {
      residentEmail: "res@example.com",
      ownerManagerUserId: MANAGER,
    });
  });

  it("treats a missing manager or malformed sender as a prospect", async () => {
    expect(await classifyAssistantEmailSender(db, { managerUserId: "", fromEmail: "a@b.com" })).toEqual({
      role: "prospect",
    });
    expect(
      await classifyAssistantEmailSender(db, { managerUserId: MANAGER, fromEmail: "not-an-email" }),
    ).toEqual({ role: "prospect" });
    expect(mocks.resolveManagerEmailInboundIdentity).not.toHaveBeenCalled();
  });
});
