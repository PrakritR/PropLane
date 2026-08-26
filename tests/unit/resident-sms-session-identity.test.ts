import { describe, expect, it, vi } from "vitest";
import { findOrCreateResidentSmsSession } from "@/lib/agent/resident-sms-agent.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const PHONE = "+12065552222";

function sessionDb(existing: Record<string, unknown> | null) {
  const equality = new Map<string, unknown>();
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((column: string, value: unknown) => {
    equality.set(column, value);
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => ({ data: existing, error: null }));
  chain.insert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  return {
    db: { from: vi.fn(() => chain) },
    equality,
    chain,
  };
}

describe("resident SMS session identity", () => {
  it("includes the verified resident user in the session lookup", async () => {
    const existing = {
      id: "session-1",
      landlord_id: MANAGER,
      user_id: RESIDENT,
      kind: "resident_sms",
      vendor_phone_e164: PHONE,
      status: "active",
    };
    const { db, equality } = sessionDb(existing);

    await expect(findOrCreateResidentSmsSession(db as never, {
      landlordId: MANAGER,
      residentUserId: RESIDENT,
      residentPhoneE164: PHONE,
    })).resolves.toEqual(existing);

    expect(equality.get("landlord_id")).toBe(MANAGER);
    expect(equality.get("user_id")).toBe(RESIDENT);
    expect(equality.get("vendor_phone_e164")).toBe(PHONE);
  });
});
