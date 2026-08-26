/**
 * The SMS confirm gate. A text reply carries no action id, so these tests pin
 * the two things that make a bare "YES" safe: an exact-match affirmative
 * vocabulary, and the one-open-proposal-at-a-time invariant.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const denyPendingAction = vi.fn();
vi.mock("@/lib/tools/pending-actions", () => ({
  denyPendingAction: (...a: unknown[]) => denyPendingAction(...a),
}));

import {
  classifySmsConfirmationReply,
  denyOpenSmsProposal,
  renderPreviewForSms,
  resolveOpenSmsProposal,
  supersedeOpenSmsProposals,
} from "@/lib/sms/agent-confirmation.server";

const USER = "11111111-1111-1111-1111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

function makeDb(opts: {
  open?: { id: string; tool_name: string; created_at: string; session_id?: string }[];
  error?: boolean;
}) {
  const { open = [], error = false } = opts;
  const equals = new Map<string, unknown>();
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation((column: string, value: unknown) => {
      equals.set(column, value);
      return chain;
    }),
    gt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi
      .fn()
      .mockImplementation(async () => error
        ? { data: null, error: { message: "boom" } }
        : {
            data: open.filter((row) => !row.session_id || row.session_id === equals.get("session_id")),
            error: null,
          }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn().mockReturnValue(chain) } as any;
}

const proposal = (id: string, tool = "start_rent_payment") => ({
  id,
  tool_name: tool,
  created_at: "2026-08-26T00:00:00.000Z",
});

beforeEach(() => {
  denyPendingAction.mockReset();
});

describe("classifySmsConfirmationReply", () => {
  it.each(["YES", "yes", " Yes ", "y", "confirm", "Approve", "YES."])("treats %j as confirm", (body) => {
    expect(classifySmsConfirmationReply(body)).toBe("confirm");
  });

  it.each(["NO", "n", "decline", "Nevermind", "NVM"])("treats %j as deny", (body) => {
    expect(classifySmsConfirmationReply(body)).toBe("deny");
  });

  it("never claims a carrier STOP keyword — CANCEL must unsubscribe, not decline", () => {
    // Regression: CANCEL was in the negative set. Compliance handling runs
    // first in /api/twilio/inbound, so a resident declining a rent payment
    // with "cancel" would have been unsubscribed from all texts instead.
    // These must stay owned by the carrier layer, so the agent sees none.
    for (const stopWord of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      expect(classifySmsConfirmationReply(stopWord)).toBe("none");
      expect(classifySmsConfirmationReply(stopWord.toLowerCase())).toBe("none");
    }
    for (const helpWord of ["HELP", "INFO"]) {
      expect(classifySmsConfirmationReply(helpWord)).toBe("none");
    }
  });

  it("keeps YES as an affirmative, which the route de-conflicts by opt-out state", () => {
    // YES is also a carrier opt-in synonym. It is too natural a confirmation to
    // give up, so /api/twilio/inbound only lets START win while the phone is
    // actually suppressed. START and UNSTOP stay carrier-only here.
    expect(classifySmsConfirmationReply("YES")).toBe("confirm");
    expect(classifySmsConfirmationReply("START")).toBe("none");
    expect(classifySmsConfirmationReply("UNSTOP")).toBe("none");
  });

  it("does not treat a sentence containing yes as an authorization", () => {
    expect(classifySmsConfirmationReply("yes I was wondering about parking")).toBe("none");
    expect(classifySmsConfirmationReply("can you confirm my rent amount?")).toBe("none");
  });

  it("deliberately excludes conversational acknowledgements", () => {
    // "ok" and "sure" are ordinary chat and must never authorize a write.
    for (const body of ["ok", "okay", "sure", "thanks", "k"]) {
      expect(classifySmsConfirmationReply(body)).toBe("none");
    }
  });

  it("treats an empty body as no intent", () => {
    expect(classifySmsConfirmationReply("   ")).toBe("none");
  });
});

describe("renderPreviewForSms", () => {
  it("renders title, summary, fields, warnings and the reply instruction", () => {
    const text = renderPreviewForSms({
      kind: "start_rent_payment",
      title: "Pay charges online",
      confirmLabel: "Open checkout",
      summary: "Pay $1,200.00 for 1 charge.",
      fields: [
        { label: "August rent", value: "$1,200.00" },
        { label: "Total due", value: "$1,200.00" },
      ],
      warnings: ["This opens a secure Stripe checkout."],
    });
    expect(text).toContain("Pay charges online");
    expect(text).toContain("August rent: $1,200.00");
    expect(text).toContain("Note: This opens a secure Stripe checkout.");
    expect(text).toContain("Reply YES to confirm or NO to cancel.");
  });

  it("caps fields so one preview cannot balloon into many segments", () => {
    const text = renderPreviewForSms({
      kind: "x",
      title: "Many",
      confirmLabel: "Go",
      fields: Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: `V${i}` })),
    });
    expect(text).toContain("L7: V7");
    expect(text).not.toContain("L8: V8");
  });
});

describe("resolveOpenSmsProposal", () => {
  it("returns the single open proposal id for the executor to claim", async () => {
    const res = await resolveOpenSmsProposal(makeDb({ open: [proposal("a1")] }), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(res).toEqual({ status: "one", actionId: "a1", toolName: "start_rent_payment" });
  });

  it("never claims or executes — resolving is read-only", async () => {
    await resolveOpenSmsProposal(makeDb({ open: [proposal("a1")] }), {
      userId: USER,
      sessionId: SESSION,
    });
    // Execution belongs to runConfirmedPendingActionForPortal, which also
    // enforces the portal binding and re-validates the stored input.
    expect(denyPendingAction).not.toHaveBeenCalled();
  });

  it("reports none rather than guessing when nothing is open", async () => {
    const res = await resolveOpenSmsProposal(makeDb({ open: [] }), { userId: USER, sessionId: SESSION });
    expect(res).toEqual({ status: "none" });
  });

  it("refuses to pick a winner when two proposals are somehow open", async () => {
    const res = await resolveOpenSmsProposal(makeDb({ open: [proposal("a2"), proposal("a1")] }), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(res).toEqual({ status: "ambiguous", count: 2 });
  });

  it("fails closed when the proposal read errors", async () => {
    const res = await resolveOpenSmsProposal(makeDb({ error: true }), { userId: USER, sessionId: SESSION });
    expect(res).toEqual({ status: "unavailable" });
  });

  it("cannot address an open proposal from another manager SMS session", async () => {
    const res = await resolveOpenSmsProposal(makeDb({
      open: [{ ...proposal("other-manager-action"), session_id: "other-session" }],
    }), { userId: USER, sessionId: SESSION });

    expect(res).toEqual({ status: "none" });
  });
});

describe("denyOpenSmsProposal", () => {
  it("declines the named proposal", async () => {
    denyPendingAction.mockResolvedValue({ toolName: "start_rent_payment" });
    const res = await denyOpenSmsProposal(makeDb({}), { userId: USER, actionId: "a1" });
    expect(res).toEqual({ denied: true, toolName: "start_rent_payment" });
  });

  it("reports failure when the deny does not stick", async () => {
    denyPendingAction.mockResolvedValue(null);
    const res = await denyOpenSmsProposal(makeDb({}), { userId: USER, actionId: "a1" });
    expect(res).toEqual({ denied: false });
  });
});

describe("supersedeOpenSmsProposals", () => {
  it("denies every open proposal so a later YES is unambiguous", async () => {
    denyPendingAction.mockResolvedValue({ toolName: "x" });
    const res = await supersedeOpenSmsProposals(makeDb({ open: [proposal("a2"), proposal("a1")] }), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(res).toEqual({ ok: true, superseded: 2 });
    expect(denyPendingAction).toHaveBeenCalledTimes(2);
  });

  it("reports failure when the read errors so the caller can refuse to propose", async () => {
    const res = await supersedeOpenSmsProposals(makeDb({ error: true }), {
      userId: USER,
      sessionId: SESSION,
    });
    expect(res).toEqual({ ok: false, superseded: 0 });
  });
});
