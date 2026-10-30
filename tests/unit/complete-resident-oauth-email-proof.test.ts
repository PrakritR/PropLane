import { describe, expect, it, vi } from "vitest";
import { completeResidentSignupFromOAuth } from "@/lib/auth/complete-resident-signup-oauth";
describe("resident OAuth application linking", () => {
  it.each([
    { email: "victim@example.com", email_confirmed_at: null },
    { email: "other@example.com", email_confirmed_at: "2026-01-01" },
  ])("refuses an unproven or mismatched mailbox before reading application records", async (user) => {
    const from = vi.fn();
    const db = { from, auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }) } } };
    const result = await completeResidentSignupFromOAuth(db as never, "user", "victim@example.com", "APP-1");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(from).not.toHaveBeenCalled();
  });
});
