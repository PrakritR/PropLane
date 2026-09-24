import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two credit invariants the SMS/voice routes rely on but never test directly:
 *  - an inbound call is bounded to five minutes, or fewer when the balance cannot
 *    fund five, and the bound is applied to the live Twilio call before answering;
 *  - a replayed model turn never re-runs tools: a fresh incomplete turn is "still
 *    processing", and only a turn older than ten minutes is claimed as an explicit
 *    interrupted reply.
 */

const wallet = vi.hoisted(() => ({
  loadCommsWallet: vi.fn(),
  reserveCommsCredit: vi.fn(),
  finishCommsCredit: vi.fn(async () => undefined),
}));
const twilio = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/comms-billing/wallet.server", () => wallet);
vi.mock("@/lib/twilio-client.server", () => ({
  createTwilioRestClient: () => ({ calls: () => ({ update: twilio.update }) }),
}));

import { reserveBoundedVoiceCall } from "@/lib/comms-billing/voice-credit.server";
import {
  INTERRUPTED_COMMS_REPLY,
  commsTurnKey,
  completeCommsTurn,
  readCommsTurnResult,
} from "@/lib/comms-billing/turn-result.server";

function dbWithoutExistingHold() {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq"]) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return chain as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TWILIO_VOICE_RECORDING;
  wallet.reserveCommsCredit.mockResolvedValue({ allowed: true, duplicate: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("inbound calls are bounded by credit, never above five minutes", () => {
  it("caps a well-funded Business caller at five minutes", async () => {
    wallet.loadCommsWallet.mockResolvedValue({ paused: false, remainingCents: 10_000 });
    expect(await reserveBoundedVoiceCall(dbWithoutExistingHold(), "owner", "CA1")).toBe(true);
    expect(wallet.reserveCommsCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ meter: "voice_minute", quantity: 5, idempotencyKey: "voice_minute:CA1" }),
    );
    expect(twilio.update).toHaveBeenCalledWith({ timeLimit: 300 });
  });

  it("shortens the call when the balance funds fewer than five minutes", async () => {
    // $0.32 left: 20¢ headroom for the first gather+turn, 12¢ / 4¢ per minute = 3 minutes.
    wallet.loadCommsWallet.mockResolvedValue({ paused: false, remainingCents: 32 });
    expect(await reserveBoundedVoiceCall(dbWithoutExistingHold(), "owner", "CA2")).toBe(true);
    expect(wallet.reserveCommsCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ meter: "voice_minute", quantity: 3 }),
    );
    expect(twilio.update).toHaveBeenCalledWith({ timeLimit: 180 });
  });

  it("declines the call when less than one funded minute remains, and reserves nothing", async () => {
    wallet.loadCommsWallet.mockResolvedValue({ paused: false, remainingCents: 23 });
    expect(await reserveBoundedVoiceCall(dbWithoutExistingHold(), "owner", "CA3")).toBe(false);
    expect(wallet.reserveCommsCredit).not.toHaveBeenCalled();
    expect(twilio.update).not.toHaveBeenCalled();
  });

  it("declines a paused (credit-reversed) account outright", async () => {
    wallet.loadCommsWallet.mockResolvedValue({ paused: true, remainingCents: 10_000 });
    expect(await reserveBoundedVoiceCall(dbWithoutExistingHold(), "owner", "CA4")).toBe(false);
    expect(wallet.reserveCommsCredit).not.toHaveBeenCalled();
  });
});

function turnDb(row: { metadata: Record<string, unknown>; created_at: string } | null, claimed = true) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "update"]) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi
    .fn()
    .mockResolvedValueOnce({ data: row, error: null })
    .mockResolvedValueOnce({ data: claimed ? { id: "evt" } : null, error: null });
  return { chain, db: chain as never };
}

describe("replayed model turns never repeat tools", () => {
  it("returns the persisted reply for a completed turn", async () => {
    const { db } = turnDb({ metadata: { turnCompleted: true, turnResult: { text: "Tour booked." } }, created_at: new Date().toISOString() });
    await expect(readCommsTurnResult(db, "owner", "turn:1", { text: INTERRUPTED_COMMS_REPLY })).resolves.toEqual({ text: "Tour booked." });
    expect(wallet.finishCommsCredit).toHaveBeenCalledWith(db, "owner", "turn:1");
  });

  it("keeps a fresh incomplete turn as 'still processing' rather than re-running the model", async () => {
    const { db, chain } = turnDb({ metadata: {}, created_at: new Date(Date.now() - 60_000).toISOString() });
    await expect(readCommsTurnResult(db, "owner", "turn:2", { text: INTERRUPTED_COMMS_REPLY })).rejects.toThrow(/still processing/);
    expect(chain.update).not.toHaveBeenCalled();
    expect(wallet.finishCommsCredit).not.toHaveBeenCalled();
  });

  it("claims a turn stale for over ten minutes as an explicit interrupted notice", async () => {
    const { db, chain } = turnDb({ metadata: { started: true }, created_at: new Date(Date.now() - 11 * 60_000).toISOString() });
    await expect(readCommsTurnResult(db, "owner", "turn:3", { text: INTERRUPTED_COMMS_REPLY })).resolves.toEqual({ text: INTERRUPTED_COMMS_REPLY });
    expect(chain.update).toHaveBeenCalledWith({
      metadata: { started: true, turnCompleted: true, turnInterrupted: true, turnResult: { text: INTERRUPTED_COMMS_REPLY } },
    });
    expect(wallet.finishCommsCredit).toHaveBeenCalledWith(db, "owner", "turn:3");
    expect(INTERRUPTED_COMMS_REPLY).toMatch(/interrupted/i);
  });

  it("does not settle credit when another worker won the stale-turn claim", async () => {
    const { db } = turnDb({ metadata: {}, created_at: new Date(Date.now() - 11 * 60_000).toISOString() }, false);
    await expect(readCommsTurnResult(db, "owner", "turn:4", { text: INTERRUPTED_COMMS_REPLY })).rejects.toThrow(/recovery is in progress/);
    expect(wallet.finishCommsCredit).not.toHaveBeenCalled();
  });

  it("keeps the reservation's provenance when a turn completes normally", async () => {
    const { db, chain } = turnDb({ metadata: { sessionId: "sess-1", channel: "sms" }, created_at: new Date().toISOString() });
    await expect(completeCommsTurn(db, "owner", "turn:5", { text: "Tour booked." })).resolves.toEqual({ text: "Tour booked." });
    expect(chain.update).toHaveBeenCalledWith({
      metadata: { sessionId: "sess-1", channel: "sms", turnCompleted: true, turnResult: { text: "Tour booked." } },
    });
    expect(wallet.finishCommsCredit).toHaveBeenCalledWith(db, "owner", "turn:5");
  });

  it("does not settle credit when the reservation is no longer held", async () => {
    const { db, chain } = turnDb(null);
    await expect(completeCommsTurn(db, "owner", "turn:6", { text: "x" })).rejects.toThrow(/could not be saved/);
    expect(chain.update).not.toHaveBeenCalled();
    expect(wallet.finishCommsCredit).not.toHaveBeenCalled();
  });
});

function keyFamilyDb(rows: Array<{ idempotency_key: string; credit_state: string; metadata?: Record<string, unknown> }>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "like"]) chain[m] = vi.fn(() => chain);
  chain.order = vi.fn(async () => ({ data: rows, error: null }));
  return chain as never;
}

describe("a failed model turn is retried under a fresh credit key, never replayed as silence", () => {
  const base = "ai_turn:sms:sess-1:msg-1";

  it("uses the base key for a first attempt", async () => {
    await expect(commsTurnKey(keyFamilyDb([]), "owner", base)).resolves.toBe(base);
  });

  it("keeps replaying a completed turn that produced a reply", async () => {
    const db = keyFamilyDb([{ idempotency_key: base, credit_state: "settled", metadata: { turnCompleted: true, turnResult: { reply: "Yes" } } }]);
    await expect(commsTurnKey(db, "owner", base)).resolves.toBe(base);
  });

  it("keeps a held reservation so a concurrent worker sees it as still processing", async () => {
    await expect(commsTurnKey(keyFamilyDb([{ idempotency_key: base, credit_state: "reserved" }]), "owner", base)).resolves.toBe(base);
  });

  it("moves past a released attempt", async () => {
    const db = keyFamilyDb([{ idempotency_key: base, credit_state: "released" }]);
    await expect(commsTurnKey(db, "owner", base)).resolves.toBe(`${base}:r1`);
  });

  it("moves past a legacy settled empty result cached before failures were released", async () => {
    const db = keyFamilyDb([
      { idempotency_key: `${base}:r1`, credit_state: "released" },
      { idempotency_key: base, credit_state: "settled", metadata: { turnCompleted: true, turnResult: null } },
    ]);
    await expect(commsTurnKey(db, "owner", base)).resolves.toBe(`${base}:r2`);
  });

  it("never retries an empty result once tools ran, or an interrupted turn", async () => {
    const toolsRan = keyFamilyDb([{ idempotency_key: base, credit_state: "settled", metadata: { turnCompleted: true, turnResult: null, turnToolsRan: true } }]);
    await expect(commsTurnKey(toolsRan, "owner", base)).resolves.toBe(base);
    const interrupted = keyFamilyDb([{ idempotency_key: base, credit_state: "settled", metadata: { turnCompleted: true, turnResult: null, turnInterrupted: true } }]);
    await expect(commsTurnKey(interrupted, "owner", base)).resolves.toBe(base);
  });

  it("ignores keys that only match through LIKE wildcards", async () => {
    const db = keyFamilyDb([{ idempotency_key: "aiXturn:sms:sess-1:msg-1", credit_state: "released" }]);
    await expect(commsTurnKey(db, "owner", base)).resolves.toBe(base);
  });

  it("ignores unrelated keys that merely share the prefix", async () => {
    const db = keyFamilyDb([{ idempotency_key: `${base}0`, credit_state: "released" }]);
    await expect(commsTurnKey(db, "owner", base)).resolves.toBe(base);
  });
});
