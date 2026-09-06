import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertCalendarBackfillTarget, protectCalendarTokens } from "../../../scripts/security/calendar-backfill";
import { decryptSensitiveValue } from "@/lib/security/data-encryption";

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
});
afterEach(() => vi.unstubAllEnvs());

describe("calendar credential backfill", () => {
  it("protects orphaned tokens without dropping metadata and is idempotent", () => {
    const original = { connected: false, refreshToken: "orphan", extra: "preserve" };
    const result = protectCalendarTokens(original, "owner");
    expect(result.plaintext).toBe(1);
    expect(original.refreshToken).toBe("orphan");
    const protectedRow = result.value as Record<string, string>;
    expect(protectedRow.extra).toBe("preserve");
    expect(decryptSensitiveValue(protectedRow.refreshToken, { purpose: "google-calendar-oauth", ownerId: "owner", recordId: "owner", field: "refreshToken" })).toBe("orphan");
    expect(protectCalendarTokens(protectedRow, "owner")).toMatchObject({ changed: false, plaintext: 0 });
    expect(() => protectCalendarTokens(protectedRow, "other")).toThrow();
  });
  it("rejects malformed tokens and future envelopes", () => {
    expect(() => protectCalendarTokens({ accessToken: 42 }, "owner")).toThrow();
    expect(() => protectCalendarTokens({ accessToken: "proplane:v2:bad" }, "owner")).toThrow();
  });
  it("blocks production apply and mismatched real database targets", () => {
    const dev = "emstjswhotsnyksqhqyf";
    const prod = "qahnczmilgptcedaqype";
    expect(() => assertCalendarBackfillTarget(`postgres://postgres@db.${dev}.supabase.co/postgres`, `https://${dev}.supabase.co`, true)).not.toThrow();
    expect(() => assertCalendarBackfillTarget(`postgres://postgres@db.${prod}.supabase.co/postgres`, `https://${prod}.supabase.co`, true)).toThrow();
    expect(() => assertCalendarBackfillTarget(`postgres://postgres@db.${prod}.supabase.co/postgres`, `https://${dev}.supabase.co`, true)).toThrow();
    expect(() => assertCalendarBackfillTarget(`postgres://postgres.${dev}@aws-1-us-west-2.pooler.supabase.com/postgres`, `https://${dev}.supabase.co`, true)).not.toThrow();
  });
});
