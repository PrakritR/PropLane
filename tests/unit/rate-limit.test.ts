import { describe, expect, it } from "vitest";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

describe("rate-limit", () => {
  it("allows requests within limit", () => {
    const key = `test-${Date.now()}`;
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(false);
  });

  // This asserted the FIRST hop, which is the caller-supplied end of the chain —
  // a proxy appends the address it observed rather than overwriting. Keying the
  // limiter on it made every IP bucket in the product caller-controlled, so the
  // test was pinning the defect. The last hop is the one our own edge saw.
  it("extracts the client IP from the last forwarded hop", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(clientIpFrom(req)).toBe("5.6.7.8");
  });
});
