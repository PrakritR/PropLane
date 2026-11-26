import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityDepositLedgerRow } from "@/lib/reports/security-deposits";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/tools/domains/resident-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/domains/resident-lookup")>()),
  resolveManagerResidents: mocks.resolve,
}));
vi.mock("@/lib/reports/security-deposits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/security-deposits")>()),
  listSecurityDeposits: mocks.list,
  getSecurityDepositById: mocks.get,
}));

import { findSecurityDepositTool } from "@/lib/tools/domains/deposit-lookup";
import { disposeSecurityDepositTool, resolveDepositDeduction } from "@/lib/tools/domains/financials-write";

const deposit = (over: Partial<SecurityDepositLedgerRow>): SecurityDepositLedgerRow => ({
  id: "d1", managerUserId: "m", sourceChargeId: "c1", propertyId: "p", unitLabel: null, leaseId: null, residentUserId: null,
  residentEmail: "mo@x.test", amountCents: 25000, amountHeldCents: 25000, receivedDate: "2026-01-01", status: "held",
  dispositionType: null, dispositionDate: null, itemization: [], ...over,
});
const match = (name: string, email: string, movedOut: boolean) => ({ name, email, movedOut, houseId: "p", houseTitle: "4709A 8th Ave NE", roomLabel: "Room 2", row: {} });
const ctx = { db: {}, landlordId: "m", workspace: null } as never;

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.list.mockReset();
  mocks.get.mockReset();
});

describe("find_security_deposit", () => {
  it("finds the held deposit of the resident who moved out of a room, by house + room", async () => {
    mocks.resolve.mockResolvedValue({ matches: [match("Mo Movedout", "mo@x.test", true)], question: null });
    mocks.list.mockResolvedValue([deposit({}), deposit({ id: "d9", residentEmail: "someone@else.test" })]);
    const out = (await findSecurityDepositTool.handler(ctx, { resident: "4709a Room 2" })) as { count: number; deposits: Array<Record<string, unknown>> };
    expect(mocks.resolve).toHaveBeenCalledWith(ctx, "4709a Room 2", { includeMovedOut: true });
    expect(out.count).toBe(1);
    expect(out.deposits[0]).toMatchObject({ depositId: "d1", resident: "Mo Movedout", movedOut: true, amountHeld: "$250.00", room: "Room 2" });
  });

  it("with the moved-out and the current resident both holding a deposit, lists the moved-out one first and says to ask", async () => {
    mocks.resolve.mockResolvedValue({ matches: [match("Eden Lease", "eden@x.test", false), match("Mo Movedout", "mo@x.test", true)], question: "More than one" });
    mocks.list.mockResolvedValue([deposit({ id: "dE", residentEmail: "eden@x.test" }), deposit({ id: "dM" })]);
    const out = (await findSecurityDepositTool.handler(ctx, { resident: "4709a Room 2" })) as { deposits: Array<{ depositId: string }>; message: string };
    expect(out.deposits.map((d) => d.depositId)).toEqual(["dM", "dE"]);
    expect(out.message).toMatch(/More than one deposit/);
  });

  it("skips a deposit that was already returned, and says none is held", async () => {
    mocks.resolve.mockResolvedValue({ matches: [match("Mo Movedout", "mo@x.test", true)], question: null });
    mocks.list.mockResolvedValue([deposit({ status: "refunded", amountHeldCents: 0 })]);
    const out = (await findSecurityDepositTool.handler(ctx, { resident: "mo" })) as { count: number; message: string };
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/No held deposit/);
  });

  it("no resident: relays the resolver's one question and reads no ledger", async () => {
    mocks.resolve.mockResolvedValue({ matches: [], question: 'No resident matches "x".' });
    const out = (await findSecurityDepositTool.handler(ctx, { resident: "x room 9" })) as { message: string };
    expect(out.message).toContain("No resident matches");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("dispose_security_deposit: itemized deduction and net, from the tool", () => {
  it("states the deduction line and the net returned: $250 held minus $50 cleaning = $200", async () => {
    mocks.get.mockResolvedValue(deposit({}));
    const preview = (await (disposeSecurityDepositTool as unknown as { preview: (c: unknown, i: unknown) => Promise<{ fields: Array<{ label: string; value: string }> }> }).preview(ctx, {
      depositId: "d1",
      withholdCents: 5000,
      itemization: [{ label: "Cleaning", amountCents: 5000 }],
      offlineReturn: { method: "check", reference: "1042" },
    }));
    const byLabel = Object.fromEntries(preview.fields.map((f) => [f.label, f.value]));
    expect(byLabel["Amount held"]).toBe("$250.00");
    expect(byLabel["Deduction: Cleaning"]).toBe("-$50.00");
    expect(byLabel["Withheld for damages"]).toBe("$50.00");
    expect(byLabel["Net returned to resident"]).toBe("$200.00");
  });

  it("a bare withholdCents plus a memo becomes one itemized line", () => {
    expect(resolveDepositDeduction({ withholdCents: 5000, memo: "Cleaning" })).toEqual({ withholdCents: 5000, lines: [{ label: "Cleaning", amountCents: 5000 }] });
    expect(resolveDepositDeduction({})).toEqual({ withholdCents: 0, lines: [] });
  });

  it("withholdCents is the one amount: an itemization only names its lines and never sets it", () => {
    expect(resolveDepositDeduction({ withholdCents: 7500, itemization: [{ label: "Cleaning", amountCents: 5000 }, { label: "Key", amountCents: 2500 }] })).toEqual({
      withholdCents: 7500,
      lines: [{ label: "Cleaning", amountCents: 5000 }, { label: "Key", amountCents: 2500 }],
    });
    // Lines with no withheld amount are a full refund: the resident keeps everything held.
    expect(resolveDepositDeduction({ itemization: [{ label: "Cleaning", amountCents: 5000 }] }).withholdCents).toBe(0);
  });

  it("refuses deductions larger than the amount held", async () => {
    mocks.get.mockResolvedValue(deposit({ amountHeldCents: 3000 }));
    await expect(
      (disposeSecurityDepositTool as unknown as { preview: (c: unknown, i: unknown) => Promise<unknown> }).preview(ctx, { depositId: "d1", withholdCents: 5000, itemization: [{ label: "Cleaning", amountCents: 5000 }], offlineReturn: { method: "cash", reference: "r" } }),
    ).rejects.toThrow(/more than the \$30\.00 held/);
  });
});
