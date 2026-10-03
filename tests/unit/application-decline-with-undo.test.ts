// Decline is one click: no confirm dialog, "Declined · name" with one Undo that restores the bucket it came from.
import { describe, expect, it, vi } from "vitest";
import { declineApplicationWithUndo, type ApplicationBucketTransition } from "@/lib/application-review";

const ok = (bucket: string) => ({ row: { bucket }, welcomeSent: false }) as unknown as ApplicationBucketTransition;

describe("declineApplicationWithUndo", () => {
  it("declines at once and offers Undo, which restores the pending bucket", async () => {
    const calls: string[] = [];
    let undo: (() => void | Promise<void>) | undefined;
    const toasts: string[] = [];
    const showToast = vi.fn((message: string, options?: { undo?: () => void | Promise<void> }) => {
      toasts.push(message);
      if (options?.undo) undo = options.undo;
    });
    const events: string[] = [];
    const done = await declineApplicationWithUndo({
      row: { id: "A1", bucket: "pending", name: "Taylor Reed", email: "t@x.com" },
      run: async (id, next) => {
        calls.push(`${id}:${next}`);
        return ok(next);
      },
      showToast,
      onChanged: (event) => events.push(event),
    });
    expect(done).toBe(true);
    expect(calls).toEqual(["A1:rejected"]);
    expect(toasts[0]).toBe("Declined · Taylor Reed");
    await undo!();
    expect(calls).toEqual(["A1:rejected", "A1:pending"]);
    expect(toasts[1]).toBe("Restored · Taylor Reed");
    expect(events).toEqual(["declined", "restored"]);
  });

  it("an approved application is restored to Approved", async () => {
    const calls: string[] = [];
    let undo: (() => void | Promise<void>) | undefined;
    await declineApplicationWithUndo({
      row: { id: "A2", bucket: "approved", name: "Marcus", email: "" },
      run: async (id, next) => {
        calls.push(`${id}:${next}`);
        return ok(next);
      },
      showToast: (_m, options) => {
        if (options?.undo) undo = options.undo;
      },
    });
    await undo!();
    expect(calls).toEqual(["A2:rejected", "A2:approved"]);
  });

  it("says why when the decline did not go through, and offers no Undo", async () => {
    const showToast = vi.fn();
    const done = await declineApplicationWithUndo({
      row: { id: "A3", bucket: "pending", name: "X", email: "" },
      run: async () => ({ blocked: "error", message: "Nope", row: {}, welcomeSent: false }) as unknown as ApplicationBucketTransition,
      showToast,
    });
    expect(done).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Nope");
  });
});
