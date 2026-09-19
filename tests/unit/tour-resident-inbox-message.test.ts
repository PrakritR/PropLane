import { describe, expect, it, vi } from "vitest";
import { recordResidentProspectInboxMessage, tourInboxMessageId } from "@/lib/tour-notification-delivery.server";

describe("recordResidentProspectInboxMessage", () => {
  it("dedupes a delivery retry but gives changed reconfirm and cancel copy a new lifecycle turn", () => {
    const parts = ["tour-1", "confirmed", "2026-09-18T18:00:00Z"];
    const retry = tourInboxMessageId(parts, "Tour confirmed", "See you at 11.");
    expect(tourInboxMessageId(parts, "Tour confirmed", "See you at 11.")).toBe(retry);
    expect(tourInboxMessageId(parts, "Tour confirmed", "Please arrive ten minutes early.")).not.toBe(retry);
    expect(tourInboxMessageId(["tour-1", "canceled", "2026-09-18T18:00:00Z"], "Tour canceled", "The tour was canceled.")).not.toBe(retry);
  });

  it("writes a resident inbox thread keyed by participant email", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === "portal_inbox_thread_records") {
          const query = {
            select: () => query,
            eq: () => query,
            order: () => query,
            limit: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
            insert: upsert,
            upsert,
          };
          return query;
        }
        return {};
      }),
    };

    await recordResidentProspectInboxMessage(db as never, {
      participantEmail: "guest@example.com",
      subject: "Tour request received",
      body: "We received your tour request.",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0]?.[0] as { participant_email?: string; scope?: string };
    expect(payload.participant_email).toBe("guest@example.com");
    expect(payload.scope).toBe("axis_portal_inbox_resident_v1");
  });

  it("stores resident outbound message and PropLane ack as separate turns", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "user-1" }, error: null }),
              }),
            }),
          };
        }
        if (table === "portal_inbox_thread_records") {
          const query = {
            select: () => query,
            eq: () => query,
            order: () => query,
            limit: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
            insert: upsert,
            upsert,
          };
          return query;
        }
        return {};
      }),
    };

    await recordResidentProspectInboxMessage(db as never, {
      participantEmail: "guest@example.com",
      subject: "We received your message — Availability",
      body: "Thanks for reaching out about Oak House.\n\nYour message was sent to the property manager.",
      residentMessage: "Is this unit still available?",
      residentName: "Alex Prospect",
      counterpartyEmail: "manager@example.com",
      managerUserId: "mgr-1",
      propertyId: "prop-oak",
      propertyTitle: "Oak House",
    });

    const rowData = (upsert.mock.calls[0]?.[0] as { row_data?: Record<string, unknown> }).row_data;
    expect(rowData?.body).toBe("Is this unit still available?");
    expect(rowData?.rootOutbound).toBe(true);
    expect(rowData?.from).toBe("Property manager (Oak House)");
    expect(rowData?.email).toBe("manager@example.com");
    expect(rowData?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.stringContaining("Thanks for reaching out about Oak House."),
          outbound: false,
        }),
      ]),
    );
  });
});
