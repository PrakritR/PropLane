import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const bus = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => { bus.calls.push(input); }) }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.example" }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ sharedPortalFromAddress: () => "PropLane <alerts@example.test>" }));
const resend = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (args: Record<string, unknown>) => { resend.calls.push(args); return { ok: true }; }),
}));
const setup = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/auth/resident-setup-token", () => ({
  ensureResidentSetupTokenForApplication: vi.fn(async (...args: unknown[]) => { setup.calls.push(args); return { ok: false }; }),
  attachResidentSetupToken: vi.fn(() => { setup.calls.push("attach"); throw new Error("must not mint"); }),
  residentSetupAccountUrl: vi.fn(() => { setup.calls.push("url"); throw new Error("must not build"); }),
}));

import { emailManagerOfMoveInFormSubmission, emitMoveInFormEvent } from "@/lib/move-in-forms/move-in-form-events.server";

const row = {
  id: "r1", manager_user_id: "owner", property_id: "home", property_label: "12 Elm", room_label: "Room 1",
  resident_name: "Resident A", resident_email: "a@example.test", resident_user_id: "res-a", form_name: "Checklist", due_at: null,
};
const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "Boss@Example.test", full_name: "Boss" } }) }) }) }) } as never;

beforeEach(() => {
  bus.calls = [];
  resend.calls = [];
  setup.calls = [];
  process.env.RESEND_API_KEY = "test-key";
});

describe("move-in form events", () => {
  it("links a sent form to that form, a direct link that works before approval when a form blocks it", async () => {
    await emitMoveInFormEvent(db, { row, event: "sent" });
    const recipients = bus.calls[0]!.recipients as { rendered: { text: string } }[];
    expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
  });

  /**
   * A bus copy is persisted in `action_event_deliveries`, appended to the portal inbox thread the
   * manager reads, and under `partyFacing: "draft"` queued for a manager to edit. An account-binding
   * setup token must never ride on it, and the notice must never mint or rotate one.
   */
  it.each(["sent", "reminder"] as const)("never carries a setup capability on a %s notice, bound or not", async (event) => {
    for (const residentUserId of ["res-a", null]) {
      bus.calls = [];
      await emitMoveInFormEvent(db, { row: { ...row, resident_user_id: residentUserId }, event, nonce: "n1" });
      const call = bus.calls[0]!;
      const serialized = JSON.stringify(call);
      expect(serialized).not.toMatch(/token/i);
      expect(serialized).not.toContain("resident-setup");
      const recipients = call.recipients as { rendered: { text: string } }[];
      expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
      expect((call.templateContext as { url: string }).url).toBe("https://app.example/resident/forms/r1");
    }
    expect(setup.calls).toEqual([]);
  });

  it("addresses a guest intake notice to the confirmed login without letting it decide the link", async () => {
    await emitMoveInFormEvent(db, {
      row: { ...row, resident_user_id: null },
      event: "sent",
      noticeAccount: { id: "confirmed-login", email: "a@example.test" },
    });
    const recipients = bus.calls[0]!.recipients as { audience: string; userId?: string; rendered: { text: string } }[];
    expect(recipients[0]).toMatchObject({ audience: "resident", userId: "confirmed-login" });
    expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
    expect(setup.calls).toEqual([]);
  });

  it("sends the submitted notice as the manager, so it lands as an Assistant notice with no email of its own", async () => {
    await emitMoveInFormEvent(db, { row, event: "submitted" });
    expect(bus.calls[0]).toMatchObject({ senderUserId: "owner", recipients: [{ audience: "manager", userId: "owner" }] });
  });

  it("the email leg goes to the manager's own address from the shared sender", async () => {
    expect(await emailManagerOfMoveInFormSubmission(db, row)).toBe(true);
    expect(resend.calls[0]).toMatchObject({
      actorUserId: "owner",
      payload: { from: "PropLane <alerts@example.test>", to: ["boss@example.test"] },
    });
    expect(String((resend.calls[0]!.payload as { text: string }).text)).toContain("Resident A submitted the Checklist");
  });

  it("sends no email without a mail key", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await emailManagerOfMoveInFormSubmission(db, row)).toBe(false);
    expect(resend.calls).toEqual([]);
  });
});
