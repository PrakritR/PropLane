import { describe, expect, it } from "vitest";
import { isBenignAuthJsBackgroundFetchFailure, isStaleRefreshTokenError } from "@/lib/supabase/safe-browser-session";

describe("isStaleRefreshTokenError", () => {
  it("detects the Supabase refresh-token-not-found message", () => {
    expect(
      isStaleRefreshTokenError({
        message: "Invalid Refresh Token: Refresh Token Not Found",
        status: 400,
      }),
    ).toBe(true);
  });

  it("detects refresh-token error codes", () => {
    expect(isStaleRefreshTokenError({ code: "refresh_token_not_found" })).toBe(true);
  });

  it("ignores unrelated auth failures", () => {
    expect(isStaleRefreshTokenError({ message: "Invalid login credentials", status: 400 })).toBe(false);
  });
});

describe("isBenignAuthJsBackgroundFetchFailure", () => {
  it("recognizes a Failed-to-fetch TypeError raised from inside auth-js's own refresh internals", () => {
    const reason = new TypeError("Failed to fetch");
    reason.stack =
      "TypeError: Failed to fetch\n" +
      "    at http://localhost:3001/_next/static/chunks/node_modules_%40supabase_auth-js_dist_module_1vqrmkg._.js:7286:23\n" +
      "    at _handleRequest (http://localhost:3001/_next/static/chunks/node_modules_%40supabase_auth-js_dist_module_1vqrmkg._.js:7069:24)\n" +
      "    at _request (...)";
    expect(isBenignAuthJsBackgroundFetchFailure(reason)).toBe(true);
  });

  it("does not swallow a Failed-to-fetch TypeError from app code", () => {
    const reason = new TypeError("Failed to fetch");
    reason.stack = "TypeError: Failed to fetch\n    at loadResidentAutopay (portal.js:1:1)";
    expect(isBenignAuthJsBackgroundFetchFailure(reason)).toBe(false);
  });

  it("does not swallow an unrelated error type", () => {
    expect(isBenignAuthJsBackgroundFetchFailure(new Error("Failed to fetch"))).toBe(false);
    expect(isBenignAuthJsBackgroundFetchFailure(new TypeError("Network request failed"))).toBe(false);
    expect(isBenignAuthJsBackgroundFetchFailure(null)).toBe(false);
  });
});
