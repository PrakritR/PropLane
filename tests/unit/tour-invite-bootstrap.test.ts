import { describe, expect, it, vi } from "vitest";
import { TOUR_INVITE_BOOTSTRAP } from "@/lib/auth/tour-invite-bootstrap";

describe("tour invitation fragment", () => {
  it("keeps the secret out of the request and removes the fragment before storing it", () => {
    const token = "a".repeat(64);
    const url = new URL(`https://example.test/auth/create-account?tour_inquiry=inq#tour_token=${token}`);
    expect(url.pathname + url.search).not.toContain(token);
    const calls: string[] = [];
    const history = { state: {}, replaceState: vi.fn((_state, _title, next) => { calls.push("clear"); expect(next).not.toContain(token); }) };
    const sessionStorage = { setItem: vi.fn((key, value) => { calls.push("store"); expect(key).toBe("proplane_tour_invite"); expect(value).toBe(token); }) };
    new Function("location", "history", "sessionStorage", "URLSearchParams", TOUR_INVITE_BOOTSTRAP)(url, history, sessionStorage, URLSearchParams);
    expect(calls).toEqual(["clear", "store"]);
  });
});
