import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  inquiryRowsFromRecord,
  loadTourInquiryById,
  linkTourInquiryToResident,
} from "@/lib/tour-resident-link.server";

function makeInquiryDb(inquiries: Record<string, unknown>[]) {
  const links: Record<string, unknown>[] = [];
  return {
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => { links.push(args); return { data: true, error: null }; }),
    from: vi.fn((table: string) => {
      if (table === "portal_schedule_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  row_data: {
                    payload: inquiries,
                  },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "resident_tour_links") {
        return {
          upsert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
            links.push(row);
            return Promise.resolve({ error: null });
          }),
        };
      }
      if (table === "portal_inbox_thread_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {};
    }),
    _links: links,
  };
}

describe("tour-resident-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses inquiry rows from singleton payload", () => {
    const rows = inquiryRowsFromRecord({
      payload: [{ id: "inq-1", kind: "tour", email: "guest@example.com" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("inq-1");
  });

  it("loads a tour inquiry by id", async () => {
    const db = makeInquiryDb([
      { id: "inq-1", kind: "tour", email: "guest@example.com" },
      { id: "inq-2", kind: "message", email: "other@example.com" },
    ]);
    const inquiry = await loadTourInquiryById(db as never, "inq-1");
    expect(inquiry?.id).toBe("inq-1");
  });

  it("refuses linking when inquiry email does not match resident email", async () => {
    const db = makeInquiryDb([{ id: "inq-1", kind: "tour", email: "guest@example.com" }]);
    const result = await linkTourInquiryToResident(db as never, {
      userId: "user-1",
      inquiryId: "inq-1",
      email: "other@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("links inquiry to resident when email matches", async () => {
    const db = makeInquiryDb([{ id: "inq-1", kind: "tour", email: "guest@example.com", propertyId: "p-1" }]);
    const result = await linkTourInquiryToResident(db as never, {
      userId: "user-1",
      inquiryId: "inq-1",
      email: "guest@example.com",
    });
    expect(result.ok).toBe(true);
    expect((db as { _links: Record<string, unknown>[] })._links).toHaveLength(1);
  });
});
