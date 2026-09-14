// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useAutosaveDraft } from "@/hooks/use-autosave-draft";

/**
 * Autosave is the contract behind every popup that lost its Save button. The
 * failure modes that matter: a half-typed value written before the pause,
 * two writes racing (an older keystroke landing after a newer one), a failed
 * write silently losing the edit, and a required field being written empty.
 */

type Draft = { title: string; notes: string };

function setup(opts: {
  save?: (d: Draft) => Promise<void | { ok: boolean; error?: string }>;
  validate?: (d: Draft) => string | null;
  enabled?: boolean;
  initial?: Draft;
}) {
  const save = opts.save ?? vi.fn(async () => undefined);
  const initial = opts.initial ?? { title: "Fix sink", notes: "" };
  const hook = renderHook(
    ({ draft, enabled }: { draft: Draft; enabled: boolean }) =>
      useAutosaveDraft<Draft>({ draft, enabled, save, validate: opts.validate }),
    { initialProps: { draft: initial, enabled: opts.enabled ?? true } },
  );
  return { ...hook, save, initial };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAutosaveDraft", () => {
  it("does not write the baseline draft, and writes once after the debounce", async () => {
    const save = vi.fn(async () => undefined);
    const { result, rerender, initial } = setup({ save });
    expect(result.current.state).toBe("idle");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(save).not.toHaveBeenCalled();

    rerender({ draft: { ...initial, title: "Fix sink now" }, enabled: true });
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: "Fix sink now", notes: "" });
    expect(result.current.state).toBe("saved");
    expect(result.current.dirty).toBe(false);
  });

  it("coalesces keystrokes: three edits inside the window become one write of the last value", async () => {
    const save = vi.fn(async () => undefined);
    const { rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, title: "F" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    rerender({ draft: { ...initial, title: "Fi" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    rerender({ draft: { ...initial, title: "Fix" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ title: "Fix", notes: "" });
  });

  it("never interleaves writes: a keystroke during an in-flight save is sent after it settles", async () => {
    let release: (() => void) | null = null;
    const order: string[] = [];
    const save = vi.fn(async (d: Draft) => {
      order.push(`start:${d.title}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(`end:${d.title}`);
    });
    const { result, rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, title: "A" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(result.current.state).toBe("saving");
    rerender({ draft: { ...initial, title: "AB" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    // Second write must not have started while the first is open.
    expect(order).toEqual(["start:A"]);
    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(order).toEqual(["start:A", "end:A", "start:AB", "end:AB"]);
    expect(result.current.state).toBe("saved");
  });

  it("holds the draft when a required field is empty and says why", async () => {
    const save = vi.fn(async () => undefined);
    const { result, rerender, initial } = setup({
      save,
      validate: (d) => (d.title.trim() ? null : "Needs a title"),
    });
    rerender({ draft: { ...initial, title: "   " }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("invalid");
    expect(result.current.reason).toBe("Needs a title");

    rerender({ draft: { ...initial, title: "Back" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith({ title: "Back", notes: "" });
    expect(result.current.state).toBe("saved");
  });

  it("keeps the edit on failure and re-sends it on retry", async () => {
    let fail = true;
    const save = vi.fn(async (d: Draft) => {
      if (fail) throw new Error("offline");
      void d;
    });
    const { result, rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, notes: "bring a wrench" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.reason).toBe("offline");
    expect(result.current.dirty).toBe(true);
    fail = false;
    await act(async () => {
      result.current.retry();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ title: "Fix sink", notes: "bring a wrench" });
    expect(result.current.state).toBe("saved");
    expect(result.current.reason).toBeNull();
  });

  it("a failed write with no message leaves reason empty, so the mark stays a bare retry", async () => {
    const save = vi.fn(async () => {
      throw new Error("");
    });
    const { result, rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, title: "X" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.reason).toBeNull();
  });

  it("flush() sends the pending draft immediately, for the close handler", async () => {
    const save = vi.fn(async () => undefined);
    const { result, rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, title: "Closing" }, enabled: true });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: "Closing", notes: "" });
  });

  it("treats a save resolving { ok: false } as a failure", async () => {
    const save = vi.fn(async () => ({ ok: false, error: "nope" }));
    const { result, rerender, initial } = setup({ save });
    rerender({ draft: { ...initial, title: "X" }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.reason).toBe("nope");
  });
});
