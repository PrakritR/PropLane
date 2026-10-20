/**
 * The saved rule template fills in what the CALLER did not decide, and never overwrites it.
 *
 * `materializeReminders` used to overlay `rule.template.body` on top of the payload, so the tour-interest
 * 72-hour nudge - which passes its own "just checking in" words - was re-written with the one-day rule's text
 * whenever a manager had set a custom template. The two nudges then said exactly the same thing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { materializeReminders } from "@/lib/reminders/queue.server";
import { normalizeReminderSettings } from "@/lib/reminders/rules";

type Row = Record<string, unknown>;

function fakeDb() {
  const upserted: Row[] = [];
  return {
    upserted,
    db: {
      from: () => ({
        upsert: async (rows: Row[]) => {
          upserted.push(...rows);
          return { error: null };
        },
      }),
    } as never,
  };
}

const settings = (template: { subject?: string; body?: string }) =>
  normalizeReminderSettings({
    rules: {
      tour_interest: { enabled: true, timings: ["after:1440"], sms: true, audience: { counterparty: true }, template },
    },
  });

const input = (payload: Record<string, unknown>) => ({
  managerUserId: "mgr-1",
  kind: "tour_interest" as const,
  subjectId: "conv:1",
  anchorIso: "2026-10-19T15:00:00Z",
  recipients: [{ email: "", phone: "+12065550100", role: "counterparty" as const }],
  payload,
});

const NOW = new Date("2026-10-19T15:00:00Z");

describe("materializeReminders and the rule template", () => {
  it("keeps the body the caller passed", async () => {
    const f = fakeDb();
    await materializeReminders(f.db, input({ customBody: "Hi, just checking in. Still want a tour?" }), settings({ body: "Saved template body" }), NOW);
    expect(f.upserted).toHaveLength(1);
    expect((f.upserted[0]!.payload as Row).customBody).toBe("Hi, just checking in. Still want a tour?");
  });

  it("applies the template only when the caller passed nothing", async () => {
    const f = fakeDb();
    await materializeReminders(f.db, input({}), settings({ body: "Saved template body", subject: "Saved subject" }), NOW);
    expect((f.upserted[0]!.payload as Row).customBody).toBe("Saved template body");
    expect((f.upserted[0]!.payload as Row).customSubject).toBe("Saved subject");
  });

  it("an empty caller body is not an answer, so the template still fills it", async () => {
    const f = fakeDb();
    await materializeReminders(f.db, input({ customBody: "   " }), settings({ body: "Saved template body" }), NOW);
    expect((f.upserted[0]!.payload as Row).customBody).toBe("Saved template body");
  });
});
