import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProspectMessagingContactToProfile,
  attachInboxThreadsToResident,
} from "@/lib/tour-resident-link.server";

describe("prospect inbox identity helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applyProspectMessagingContactToProfile stores the tour/message form email on the profile", async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { email: "asda@gmail.com", phone: null } }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: updateEq }),
      })),
    };

    await applyProspectMessagingContactToProfile(db as never, {
      userId: "user-1",
      contactEmail: "ogambik22@gmail.com",
      phone: "(206) 555-0100",
    });

    expect(updateEq).toHaveBeenCalledWith("id", "user-1");
  });

  /**
   * `phone_verified_at` belongs to the NUMBER, not the profile row. Leaving the
   * stamp in place while writing a different number hands a brand-new,
   * unverified number the previous number's authority — a deliverable SMS
   * destination to `portal-inbox-delivery` and an authorized inbound-SMS
   * identity to `claw-manager-actions`, agent commands included. This helper is
   * reachable from `/api/auth/create-resident-account`, which takes `phone`
   * from any authenticated caller, so the rule has to hold here rather than at
   * a call site.
   */
  function profileDbWith(existing: { email: string | null; phone: string | null }) {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const db = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: existing }),
          }),
        }),
        update,
      })),
    };
    return { db, update };
  }

  it("retires phone_verified_at whenever the number changes", async () => {
    // The stored value is already E.164 — the helper normalizes before it
    // compares, so a fixture in display form would read as a change every time.
    const { db, update } = profileDbWith({ email: "guest@example.com", phone: "+12065550100" });

    await applyProspectMessagingContactToProfile(db as never, {
      userId: "user-1",
      contactEmail: "guest@example.com",
      phone: "(206) 555-0199",
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      phone: "+12065550199",
      phone_verified_at: null,
    });
  });

  it("leaves phone_verified_at alone when only the email changes", async () => {
    const { db, update } = profileDbWith({ email: "old@example.com", phone: "+12065550100" });

    await applyProspectMessagingContactToProfile(db as never, {
      userId: "user-1",
      contactEmail: "new@example.com",
      phone: "(206) 555-0100",
    });

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch).toMatchObject({ email: "new@example.com" });
    expect(patch).not.toHaveProperty("phone");
    expect(patch).not.toHaveProperty("phone_verified_at");
  });

  it("backfills owner_user_id on pre-account inbox threads for the email", async () => {
    const updateIn = vi.fn().mockResolvedValue({ error: null });
    const selectChain = {
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ id: "thread-1" }, { id: "thread-2" }],
        error: null,
      }),
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === "portal_inbox_thread_records") {
          return {
            select: vi.fn().mockReturnValue(selectChain),
            update: vi.fn().mockReturnValue({ in: updateIn }),
          };
        }
        return {};
      }),
    };

    await attachInboxThreadsToResident(db as never, "user-abc", "guest@example.com");
    expect(updateIn).toHaveBeenCalledWith("id", ["thread-1", "thread-2"]);
  });
});
