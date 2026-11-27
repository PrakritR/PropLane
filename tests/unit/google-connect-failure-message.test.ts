import { describe, expect, it } from "vitest";
import { googleConnectFailureCode, googleConnectFailureMessage } from "@/lib/google-calendar/connect-failure";

/** Muse #83: a failed connect reached the manager as "unknown" because a Supabase error is not an `Error`. */
describe("Google connect failure message", () => {
  it("keeps a thrown Error's message", () => {
    expect(googleConnectFailureMessage(new Error("Bad Request: redirect_uri_mismatch"))).toBe("Bad Request: redirect_uri_mismatch");
  });

  it("reads the message off a Supabase PostgrestError-shaped object", () => {
    const postgrest = { message: "Account recovery decision required", code: "P0001", details: null, hint: null };
    expect(googleConnectFailureMessage(postgrest)).toBe("Account recovery decision required");
    expect(googleConnectFailureCode(postgrest)).toBe("P0001");
  });

  it("falls back to an actionable sentence, never the word unknown", () => {
    expect(googleConnectFailureMessage(undefined)).toBe("Could not connect Google Calendar. Try Connect again.");
    expect(googleConnectFailureMessage({})).not.toMatch(/unknown/i);
    expect(googleConnectFailureCode("boom")).toBeNull();
  });
});
