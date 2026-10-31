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
const setup = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: { ok: true, token: "setup-token", axisId: "AXIS-1", email: "a@example.test" } as Record<string, unknown>,
}));
vi.mock("@/lib/auth/resident-setup-token", () => ({
  ensureResidentSetupTokenForApplication: vi.fn(async (_db: unknown, axisId: string, options?: unknown) => {
    setup.calls.push({ axisId, options });
    return setup.result;
  }),
  residentSetupAccountUrl: (origin: string, token: string, axisId: string) => `${origin}/auth/resident-setup?token=${token}&proplane_id=${axisId}`,
}));

import { emailManagerOfMoveInFormSubmission, emitMoveInFormEvent } from "@/lib/move-in-forms/move-in-form-events.server";

const row = {
  id: "r1", application_id: "AXIS-1", manager_user_id: "owner", property_id: "home", property_label: "12 Elm", room_label: "Room 1",
  resident_name: "Resident A", resident_email: "a@example.test", resident_user_id: "res-a", form_name: "Checklist", due_at: null,
};
const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "Boss@Example.test", full_name: "Boss" } }) }) }) }) } as never;

beforeEach(() => {
  bus.calls = [];
  resend.calls = [];
  setup.calls = [];
  setup.result = { ok: true, token: "setup-token", axisId: "AXIS-1", email: "a@example.test" };
  process.env.RESEND_API_KEY = "test-key";
});

describe("move-in form events", () => {
  it("links a sent form to that form, a direct link that works before approval when a form blocks it", async () => {
    await emitMoveInFormEvent(db, { row, event: "sent" });
    const recipients = bus.calls[0]!.recipients as { rendered: { text: string } }[];
    expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
  });

  it("points an unbound form at the emailed setup link that binds it, not at a form nobody can open", async () => {
    await emitMoveInFormEvent(db, { row: { ...row, resident_user_id: null }, event: "sent" });
    const recipients = bus.calls[0]!.recipients as { rendered: { text: string } }[];
    expect(recipients[0]!.rendered.text).toContain("https://app.example/auth/resident-setup?token=setup-token&proplane_id=AXIS-1");
    expect(recipients[0]!.rendered.text).not.toContain("/resident/forms/r1");
    expect(setup.calls[0]).toEqual({ axisId: "AXIS-1", options: { managerUserId: "owner" } });
  });

  it("keeps the direct form link when the setup capability does not belong to the form's address", async () => {
    setup.result = { ok: true, token: "setup-token", axisId: "AXIS-1", email: "someone-else@example.test" };
    await emitMoveInFormEvent(db, { row: { ...row, resident_user_id: null }, event: "sent" });
    const recipients = bus.calls[0]!.recipients as { rendered: { text: string } }[];
    expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
  });

  it("addresses a guest intake notice to the confirmed login without letting it decide the link", async () => {
    await emitMoveInFormEvent(db, {
      row: { ...row, resident_user_id: null },
      event: "sent",
      noticeAccount: { id: "confirmed-login", email: "a@example.test" },
    });
    const recipients = bus.calls[0]!.recipients as { audience: string; userId?: string; rendered: { text: string } }[];
    expect(recipients[0]).toMatchObject({ audience: "resident", userId: "confirmed-login" });
    expect(recipients[0]!.rendered.text).toContain("/auth/resident-setup?token=setup-token");
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
