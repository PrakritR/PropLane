import { describe, expect, it, vi } from "vitest";
import { purgeSharedAccountAttachments } from "@/lib/auth/purge-shared-account-attachments";

describe("shared attachment cleanup", () => {
  it("keeps surviving support/recipient references and removes orphaned uploads", async () => {
    const remove = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async (_: string, args: { p_candidates: { path: string }[] }) => ({
      data: args.p_candidates.filter(row => row.path.endsWith("shared.pdf")).map(row => row.path), error: null,
    }));
    const db = { rpc, storage: { from: () => ({
      list: async () => ({ data: [{ name: "shared.pdf", id: "shared" }, { name: "orphan.pdf", id: "orphan" }], error: null }), remove,
    }) } };
    await purgeSharedAccountAttachments(db as never, "owner");
    expect(remove.mock.calls).toEqual([
      [["owner/orphan.pdf"]], [["bug-feedback/owner/orphan.pdf"]],
    ]);
  });

  it("fails closed when reference ownership is unreadable", async () => {
    const remove = vi.fn();
    const db = { rpc: async () => ({ data: null, error: { message: "database unavailable" } }), storage: { from: () => ({
      list: async () => ({ data: [{ name: "receipt.pdf", id: "file" }], error: null }), remove,
    }) } };
    await expect(purgeSharedAccountAttachments(db as never, "owner")).rejects.toThrow("Attachment ownership check failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
