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

import { emailManagerOfMoveInFormSubmission, emitMoveInFormEvent } from "@/lib/move-in-forms/move-in-form-events.server";

const row = {
  id: "r1", manager_user_id: "owner", property_id: "home", property_label: "12 Elm", room_label: "Room 1",
  resident_name: "Resident A", resident_email: "a@example.test", resident_user_id: "res-a", form_name: "Checklist", due_at: null,
};
const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "Boss@Example.test", full_name: "Boss" } }) }) }) }) } as never;

beforeEach(() => {
  bus.calls = [];
  resend.calls = [];
  process.env.RESEND_API_KEY = "test-key";
});

describe("move-in form events", () => {
  it("links a sent form to that form, a direct link that works before approval when a form blocks it", async () => {
    await emitMoveInFormEvent(db, { row, event: "sent" });
    const recipients = bus.calls[0]!.recipients as { rendered: { text: string } }[];
    expect(recipients[0]!.rendered.text).toContain("https://app.example/resident/forms/r1");
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
