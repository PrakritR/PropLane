import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitInboxThreadReply } from "@/lib/portal-inbox-delivery";

const target = {
  threadId: "thread-1", scope: "axis_portal_inbox_manager_v1", ownerUserId: "manager-1",
  participantEmail: null, threadType: "agent_notice", rowData: {},
};

function database(read: { data: unknown; error: unknown }, writeError: unknown = null) {
  const upsert = vi.fn(async () => ({ error: writeError }));
  const query = { select: () => query, eq: () => query, maybeSingle: async () => read, upsert };
  return { db: { from: () => query } as unknown as SupabaseClient, upsert };
}

describe("inbox reply persistence acknowledgment", () => {
  it("does not acknowledge a failed read or write a guessed transcript", async () => {
    const { db, upsert } = database({ data: null, error: { code: "08006" } });
    await expect(commitInboxThreadReply(db, target, { fromName: "Manager", text: "Hello" }))
      .rejects.toThrow("Could not load the conversation");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not acknowledge a deleted conversation", async () => {
    const { db, upsert } = database({ data: null, error: null });
    await expect(commitInboxThreadReply(db, target, { fromName: "Manager", text: "Hello" }))
      .rejects.toThrow("This conversation is no longer available");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not acknowledge a rejected upsert", async () => {
    const { db } = database({ data: { id: "thread-1", row_data: { messages: [] } }, error: null },
      { code: "42501" });
    await expect(commitInboxThreadReply(db, target, { fromName: "Manager", text: "Hello" }))
      .rejects.toThrow("Could not save the reply");
  });

  it("acknowledges a saved reply and preserves existing transcript entries", async () => {
    const { db, upsert } = database({ data: { id: "thread-1", row_data: { messages: [
      { id: "first", body: "Original" },
    ] } }, error: null });
    await expect(commitInboxThreadReply(db, target, { fromName: "Manager", text: "Hello" })).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      row_data: expect.objectContaining({ messages: [
        { id: "first", body: "Original" }, expect.objectContaining({ body: "Hello" }),
      ] }),
    }), { onConflict: "id" });
  });
});
