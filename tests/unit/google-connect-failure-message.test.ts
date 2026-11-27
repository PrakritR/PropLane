import { describe, expect, it } from "vitest";
import {
  googleConnectFailureCode,
  googleConnectFailureDetail,
  googleConnectFailureMessage,
} from "@/lib/google-calendar/connect-failure";

/** Muse #83: a failed connect reached the manager as "unknown" because a Supabase error is not an `Error`. */
describe("Google connect failure message", () => {
  it("keeps a thrown Error's message", () => {
    expect(googleConnectFailureMessage(new Error("Bad Request: redirect_uri_mismatch"))).toBe("Bad Request: redirect_uri_mismatch");
  });

  it("shows a fixed sentence with the code for a Supabase PostgrestError, never its raw text", () => {
    const postgrest = {
      message: 'duplicate key value violates unique constraint "manager_google_calendar_connections_pkey"',
      code: "23505",
      details: "Key (manager_user_id)=(abc) already exists.",
      hint: null,
    };
    const shown = googleConnectFailureMessage(postgrest);
    expect(shown).toBe("Could not save your Google connection (code 23505). Try Connect again.");
    expect(shown).not.toMatch(/constraint|manager_user_id/);
    expect(googleConnectFailureCode(postgrest)).toBe("23505");
    expect(googleConnectFailureDetail(postgrest)).toContain("manager_google_calendar_connections_pkey");
  });

  it("drops a code that is not a plain code", () => {
    expect(googleConnectFailureMessage({ code: "<script>" })).toBe("Could not save your Google connection. Try Connect again.");
  });

  it("falls back to an actionable sentence, never the word unknown", () => {
    expect(googleConnectFailureMessage(undefined)).toBe("Could not connect Google Calendar. Try Connect again.");
    expect(googleConnectFailureMessage({})).not.toMatch(/unknown/i);
    expect(googleConnectFailureCode("boom")).toBeNull();
  });
});
