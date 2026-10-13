import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const deliver = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: (...a: unknown[]) => deliver(...a) }));
const send = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: (...a: unknown[]) => send(...a) }));
vi.mock("@/lib/twilio-provisioning", () => ({ resolveManagerWorkNumber: async () => "+12065550100" }));
let fake = createFakeDb({});
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fake }));

import { notifyCoManagerInviteSent } from "@/lib/co-manager-notification.server";

const input = { inviterUserId: "inv", inviteeUserId: "mate", inviterName: "Ambika", propertyLabels: ["5257 Brooklyn"], inviteId: "i1", workspaceName: "Seattle Homes" };

beforeEach(() => {
  deliver.mockClear(); send.mockClear();
});

describe("notifyCoManagerInviteSent text", () => {
  it("texts from the inviter's work number when the invitee's phone is verified", async () => {
    fake = createFakeDb({ profiles: [
      { id: "inv", email: "a@x.com", full_name: "Ambika" },
      { id: "mate", email: "m@x.com", full_name: "Mate", phone: "+12065550199", phone_verified_at: "2026-10-01T00:00:00Z" },
    ] });
    await notifyCoManagerInviteSent(input);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]![0] as { to: string; fromNumber: string; managerUserId: string; text: string };
    expect(arg).toMatchObject({ to: "+12065550199", fromNumber: "+12065550100", managerUserId: "inv" });
    expect(arg.text).toContain("Ambika invited you to Seattle Homes on PropLane.");
    expect(arg.text).toContain("Houses: 5257 Brooklyn");
  });
  it("sends no text without a verified phone", async () => {
    fake = createFakeDb({ profiles: [
      { id: "inv", email: "a@x.com", full_name: "Ambika" },
      { id: "mate", email: "m@x.com", full_name: "Mate", phone: "+12065550199", phone_verified_at: null },
    ] });
    await notifyCoManagerInviteSent(input);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
