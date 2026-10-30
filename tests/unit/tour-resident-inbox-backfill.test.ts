import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachInboxThreadsToResident } from "@/lib/tour-resident-link.server";

describe("attachInboxThreadsToResident", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("backfills owner_user_id on pre-account inbox threads for the email", async () => {
    const updateIs = vi.fn().mockResolvedValue({ error: null });
    const updateIn = vi.fn().mockReturnValue({ is: updateIs });
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
    expect(updateIs).toHaveBeenCalledWith("owner_user_id", null);
  });
});
