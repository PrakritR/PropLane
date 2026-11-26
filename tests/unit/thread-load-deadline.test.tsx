// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadLoadExpired } from "@/components/portal/portal-inbox-ui";

afterEach(() => vi.useRealTimers());

describe("a thread pane never says Loading conversation forever", () => {
  it("expires the wait for an unresolved conversation and resets when it changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useThreadLoadExpired(id, 1000), {
      initialProps: { id: "t1" as string | null },
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(result.current).toBe(true);
    rerender({ id: "t2" });
    expect(result.current).toBe(false);
    rerender({ id: null });
    expect(result.current).toBe(false);
  });
});
