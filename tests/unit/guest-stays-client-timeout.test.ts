// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGuestStays, GUEST_STAYS_TIMEOUT_MS, GuestStaysError } from "@/lib/short-stay/guest-stays-client";

afterEach(() => vi.unstubAllGlobals());

describe("fetchGuestStays is bounded (the list used to hang on its skeletons)", () => {
  it("sends a 15 second abort signal with the request", async () => {
    expect(GUEST_STAYS_TIMEOUT_MS).toBe(15_000);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ stays: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchGuestStays()).resolves.toEqual([]);
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("turns a timed-out request into an error the list can show with Try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }));
    const error = await fetchGuestStays().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GuestStaysError);
    expect((error as GuestStaysError).message).toMatch(/Could not load your stays/);
  });

  it("still reports a server refusal as itself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Sign in again." }), { status: 401 })));
    await expect(fetchGuestStays()).rejects.toMatchObject({ message: "Sign in again.", status: 401 });
  });
});
