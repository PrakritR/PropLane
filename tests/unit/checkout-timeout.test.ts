import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_TIMEOUT_MESSAGE,
  CheckoutTimeoutError,
  fetchJsonWithTimeout,
} from "@/lib/comms-billing/checkout-timeout";

describe("fetchJsonWithTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the parsed body and status when the request answers in time", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ clientSecret: "cs_1" }), { status: 200 }));
    const out = await fetchJsonWithTimeout<{ clientSecret: string }>("/x", {}, 1000, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: true, status: 200, body: { clientSecret: "cs_1" } });
  });

  it("reports a non-ok answer without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 409 }));
    const out = await fetchJsonWithTimeout<{ error: string }>("/x", {}, 1000, fetchImpl as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(out.body.error).toBe("no");
  });

  it("rejects with a retryable timeout error instead of waiting forever, even if fetch ignores its signal", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const pending = fetchJsonWithTimeout("/x", {}, 15_000, fetchImpl as unknown as typeof fetch);
    const assertion = expect(pending).rejects.toBeInstanceOf(CheckoutTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await expect(pending).rejects.toThrow(CHECKOUT_TIMEOUT_MESSAGE);
  });

  it("passes an abort signal to fetch and aborts it on timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const pending = fetchJsonWithTimeout("/x", {}, 500, fetchImpl as unknown as typeof fetch);
    const assertion = expect(pending).rejects.toBeInstanceOf(CheckoutTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});
