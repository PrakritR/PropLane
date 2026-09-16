import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn(async () => ({ eventId: "e", duplicate: false, delivered: 0, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: (...args: unknown[]) => emitActionEvent(...(args as [])),
}));

import {
  emitAvailabilityChangedEvent,
  emitTourClaimedEvent,
  emitTourManagerEvent,
  renderTourTeamEvent,
} from "@/lib/tour-events.server";

function fakeDb(profiles: Record<string, { email?: string; full_name?: string }>) {
  const from = (table: string) => {
    if (table !== "profiles") throw new Error(`unexpected table ${table}`);
    let matchedId = "";
    return {
      select() { return this; },
      eq(_column: string, value: string) { matchedId = value; return this; },
      maybeSingle() {
        const row = profiles[matchedId];
        return Promise.resolve({ data: row ? { email: row.email, full_name: row.full_name } : null, error: null });
      },
    };
  };
  return { from } as unknown as SupabaseClient;
}

describe("tour-events: team audience + new events (WS5)", () => {
  beforeEach(() => emitActionEvent.mockClear());

  it("renderTourTeamEvent produces neutral, team-voiced copy (no 'I')", () => {
    const rendered = renderTourTeamEvent({ guestName: "Alex Guest", propertyTitle: "5257 Brooklyn", whenLabel: "4:00 PM" });
    expect(rendered.text).toBe("A tour with Alex Guest at 5257 Brooklyn is confirmed for 4:00 PM.");
  });

  it("emitTourManagerEvent adds a team recipient only for 'confirmed', not 'cancelled_by_guest'", async () => {
    const db = fakeDb({ "manager-1": { email: "manager@example.com", full_name: "Manager Name" } });
    await emitTourManagerEvent(db, {
      event: "confirmed", managerUserId: "manager-1", tourId: "tour-1",
      guestName: "Alex Guest", propertyTitle: "5257 Brooklyn", whenLabel: "4:00 PM",
    });
    const call = emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call.recipients.map((r) => r.audience).sort()).toEqual(["manager", "team"]);

    emitActionEvent.mockClear();
    await emitTourManagerEvent(db, {
      event: "cancelled_by_guest", managerUserId: "manager-1", tourId: "tour-1",
      guestName: "Alex Guest",
    });
    const call2 = emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call2.recipients.map((r) => r.audience)).toEqual(["manager"]);
  });

  it("emitTourClaimedEvent is team-only, sent as the claiming manager, with the exact plan copy shape", async () => {
    const db = fakeDb({ "claimer-1": { email: "claimer@example.com", full_name: "Sam Claimer" } });
    await emitTourClaimedEvent(db, {
      managerUserId: "owner-1",
      tourId: "tour-9",
      guestName: "Jordan Guest",
      propertyTitle: "4709A 8th Ave",
      whenLabel: "2:00 PM",
      claimedByUserId: "claimer-1",
    });
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
    const [, call] = emitActionEvent.mock.calls[0]!;
    const typed = call as {
      domain: string; event: string; managerUserId: string; senderUserId: string; senderEmail: string;
      recipients: Array<{ audience: string; userId: string; rendered: { text: string } }>;
    };
    expect(typed.domain).toBe("tour");
    expect(typed.event).toBe("claimed");
    expect(typed.managerUserId).toBe("owner-1");
    expect(typed.senderUserId).toBe("claimer-1");
    expect(typed.senderEmail).toBe("claimer@example.com");
    expect(typed.recipients).toEqual([
      expect.objectContaining({ audience: "team", userId: "owner-1" }),
    ]);
    expect(typed.recipients[0]!.rendered.text).toContain("Heads up team — I'm taking the 2:00 PM tour with Jordan Guest at 4709A 8th Ave.");
  });

  it("emitTourClaimedEvent no-ops when the claiming manager has no email on file", async () => {
    const db = fakeDb({});
    await emitTourClaimedEvent(db, {
      managerUserId: "owner-1", tourId: "tour-9", guestName: "Jordan Guest", claimedByUserId: "ghost",
    });
    expect(emitActionEvent).not.toHaveBeenCalled();
  });

  it("emitAvailabilityChangedEvent is team-only and skips an empty summary", async () => {
    const db = fakeDb({ "manager-1": { email: "manager@example.com", full_name: "Manager Name" } });
    await emitAvailabilityChangedEvent(db, {
      managerUserId: "owner-1", changedByUserId: "manager-1", summary: "blocked Fri 2-5pm",
    });
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
    const [, call] = emitActionEvent.mock.calls[0]!;
    const typed = call as { domain: string; event: string; recipients: Array<{ audience: string }> };
    expect(typed.domain).toBe("availability");
    expect(typed.event).toBe("changed");
    expect(typed.recipients).toEqual([expect.objectContaining({ audience: "team" })]);

    emitActionEvent.mockClear();
    await emitAvailabilityChangedEvent(db, { managerUserId: "owner-1", changedByUserId: "manager-1", summary: "   " });
    expect(emitActionEvent).not.toHaveBeenCalled();
  });
});
