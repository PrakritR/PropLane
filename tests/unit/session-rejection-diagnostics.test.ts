import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A rejected session used to return `401 {"error":"Unauthorized."}` and write
 * nothing anywhere: expired, malformed, wrong project, clock skew and
 * cookie-never-sent were all identical from the outside. Establishing which one
 * it was (PRP-259) took minting a token by hand in Node and presenting the same
 * cookie to two servers to prove the application code was fine.
 */
const cookieJar = vi.hoisted(() => ({ all: [] as { name: string; value: string }[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => cookieJar.all }),
}));

import { getUserOrRejection } from "@/lib/auth/session-rejection";

function supabaseThatFails(message?: string) {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: message ? { message } : null }),
    },
  } as never;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  cookieJar.all = [];
  // A fresh spy per test: `mockImplementation` alone keeps the call history
  // from earlier tests, which made the "does not warn" case fail on someone
  // else's calls.
  vi.restoreAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("session rejection diagnostics", () => {
  it("distinguishes a cookie that was never sent", async () => {
    const { rejection } = await getUserOrRejection(supabaseThatFails("Auth session missing!"), "GET /x");
    expect(rejection?.reason).toBe("no-cookie");
    expect(rejection?.cookie.present).toBe(false);
  });

  it("distinguishes an expired session from a rejected one", async () => {
    cookieJar.all = [{ name: "sb-abc-auth-token", value: "x".repeat(2000) }];
    const expired = await getUserOrRejection(supabaseThatFails("JWT expired"), "GET /x");
    expect(expired.rejection?.reason).toBe("expired");

    const rejected = await getUserOrRejection(supabaseThatFails("invalid claim: issuer"), "GET /x");
    expect(rejected.rejection?.reason).toBe("rejected-by-supabase");
  });

  it("distinguishes a cookie the server could not read", async () => {
    cookieJar.all = [{ name: "sb-abc-auth-token", value: "not-base64" }];
    const { rejection } = await getUserOrRejection(supabaseThatFails("malformed JWT"), "GET /x");
    expect(rejection?.reason).toBe("unreadable-cookie");
  });

  it("records whether the cookie was chunked and how big it was", async () => {
    // @supabase/ssr splits a large session across `.0` / `.1`. An UNCHUNKED
    // cookie near the ~4096-byte limit is the shape that gets silently dropped
    // and then looks exactly like a rejection.
    cookieJar.all = [
      { name: "sb-abc-auth-token.0", value: "a".repeat(3000) },
      { name: "sb-abc-auth-token.1", value: "b".repeat(500) },
      { name: "unrelated", value: "ignored" },
    ];
    const { rejection } = await getUserOrRejection(supabaseThatFails("JWT expired"), "GET /x");
    expect(rejection?.cookie).toEqual({ present: true, chunked: true, bytes: 3500 });
  });

  it("NEVER writes the token to the log", async () => {
    const secret = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SUPER_SECRET_TOKEN";
    cookieJar.all = [{ name: "sb-abc-auth-token", value: secret }];
    await getUserOrRejection(supabaseThatFails("JWT expired"), "GET /x");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("SUPER_SECRET_TOKEN");
    // …but it does say where and why.
    expect(logged).toContain("GET /x");
    expect(logged).toContain("expired");
  });

  it("returns the user untouched when the session is good", async () => {
    const ok = {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    } as never;
    const { user, rejection } = await getUserOrRejection(ok, "GET /x");
    expect(user).toEqual({ id: "u1" });
    expect(rejection).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
