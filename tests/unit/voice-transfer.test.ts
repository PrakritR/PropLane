import { describe, expect, it, vi } from "vitest";
import {
  callerWantsHuman,
  resolveManagerTransferTarget,
  transferUnavailablePrompt,
} from "@/lib/voice/voice-transfer.server";

function dbWithProfile(profile: Record<string, unknown> | null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: profile }) })),
      })),
    })),
  } as never;
}

const VERIFIED = { phone: "+15105791976", phone_verified_at: "2026-09-01T00:00:00.000Z" };

describe("callerWantsHuman", () => {
  it("recognises the ordinary ways a caller asks for a person", () => {
    for (const said of [
      "can I speak to a person",
      "transfer me",
      "I want to talk to the manager",
      "get me a human",
      "real person please",
    ]) {
      expect(callerWantsHuman(said), said).toBe(true);
    }
  });

  it("does not fire on ordinary questions that merely mention people", () => {
    for (const said of [
      "the person who lives upstairs is loud",
      "when is my rent due",
      "is the manager going to fix the sink",
      "",
    ]) {
      expect(callerWantsHuman(said), said).toBe(false);
    }
  });
});

describe("resolveManagerTransferTarget", () => {
  it("bridges to the manager's verified mobile, calling from the work number", async () => {
    const res = await resolveManagerTransferTarget(dbWithProfile(VERIFIED), {
      managerUserId: "mgr-1",
      workNumber: "+15645652487",
      callerIsManager: false,
    });
    expect(res).toEqual({ ok: true, toPhone: "+15105791976", callerId: "+15645652487" });
  });

  it("refuses an UNVERIFIED mobile — we do not dial a number nobody confirmed", async () => {
    const res = await resolveManagerTransferTarget(
      dbWithProfile({ phone: "+15105791976", phone_verified_at: null }),
      { managerUserId: "mgr-1", workNumber: "+15645652487", callerIsManager: false },
    );
    expect(res).toEqual({ ok: false, reason: "no_verified_mobile" });
  });

  it("refuses when there is no mobile at all", async () => {
    const res = await resolveManagerTransferTarget(dbWithProfile({ phone: null, phone_verified_at: null }), {
      managerUserId: "mgr-1",
      workNumber: "+15645652487",
      callerIsManager: false,
    });
    expect(res).toEqual({ ok: false, reason: "no_verified_mobile" });
  });

  it("refuses to dial the work number back into itself", async () => {
    const res = await resolveManagerTransferTarget(
      dbWithProfile({ phone: "+15645652487", phone_verified_at: "2026-09-01T00:00:00.000Z" }),
      { managerUserId: "mgr-1", workNumber: "+15645652487", callerIsManager: false },
    );
    // Without this the bridged call re-enters the voice webhook and loops.
    expect(res).toEqual({ ok: false, reason: "would_loop" });
  });

  it("refuses when the caller IS the manager — that would ring their own phone", async () => {
    const res = await resolveManagerTransferTarget(dbWithProfile(VERIFIED), {
      managerUserId: "mgr-1",
      workNumber: "+15645652487",
      callerIsManager: true,
    });
    expect(res).toEqual({ ok: false, reason: "caller_is_manager" });
  });

  it("every refusal has caller-facing copy", () => {
    for (const reason of ["caller_is_manager", "no_verified_mobile", "would_loop"] as const) {
      expect(transferUnavailablePrompt(reason).length).toBeGreaterThan(10);
    }
  });
});
