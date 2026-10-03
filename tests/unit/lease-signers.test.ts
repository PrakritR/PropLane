// "Who has signed" on a lease record: Resident · Sent / Signed with Remind, You · Waiting with Sign,
// and a joint shared-room lease listing every roommate before the manager.
import { describe, expect, it } from "vitest";
import { leaseSignerRows, leaseSignersSummary } from "@/lib/lease-signers";
import { jointRoomCountersignBlocker, jointRoomSiblings, jointRoomAllResidentsSigned } from "@/lib/lease-joint-room";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function lease(over: Partial<LeasePipelineRow>): LeasePipelineRow {
  return {
    id: "lease_a",
    residentName: "Casey Morgan",
    residentEmail: "casey@example.com",
    unit: "Alder House · Room 8",
    stageLabel: "Resident Signature Pending",
    updated: "Sep 24",
    bucket: "resident",
    status: "Resident Signature Pending",
    pdfVersion: 1,
    notes: "",
    thread: [],
    managerSignature: null,
    residentSignature: null,
    ...over,
  } as LeasePipelineRow;
}

describe("leaseSignerRows", () => {
  it("shows nothing for a draft or a voided lease", () => {
    expect(leaseSignerRows(lease({ bucket: "manager", status: "Draft" }))).toEqual([]);
    expect(leaseSignerRows(lease({ status: "Voided" }))).toEqual([]);
  });

  it("a sent lease waits on the resident (Remind) and on you (no Sign yet)", () => {
    const rows = leaseSignerRows(lease({ sentToResidentAt: "2026-09-24T12:00:00.000Z" }), { managerName: "Alex Rivera" });
    expect(rows.map((r) => [r.role, r.state, r.action])).toEqual([
      ["Resident", "sent", "remind"],
      ["You", "waiting", null],
    ]);
    expect(rows[0]!.at).toBe("2026-09-24T12:00:00.000Z");
  });

  it("once the resident signs, only you are left and you get the Sign button", () => {
    const rows = leaseSignerRows(
      lease({
        bucket: "signed",
        status: "Manager Signature Pending",
        residentSignature: { role: "resident", name: "Casey Morgan", signedAtIso: "2026-09-29T09:00:00.000Z" },
      }),
    );
    expect(rows.map((r) => [r.role, r.state, r.action])).toEqual([
      ["Resident", "signed", null],
      ["You", "waiting", "sign"],
    ]);
  });

  it("a fully signed lease is two signed rows and no actions", () => {
    const rows = leaseSignerRows(
      lease({
        bucket: "signed",
        status: "Fully Signed",
        residentSignature: { role: "resident", name: "Casey Morgan", signedAtIso: "2026-09-29T09:00:00.000Z" },
        managerSignature: { role: "manager", name: "Alex Rivera", signedAtIso: "2026-09-30T09:00:00.000Z" },
      }),
    );
    expect(rows.every((r) => r.state === "signed" && r.action === null)).toBe(true);
    expect(leaseSignersSummary(rows)).toEqual({ signed: 2, total: 2 });
  });
});

describe("a joint shared-room lease", () => {
  const signed = { role: "resident" as const, name: "x", signedAtIso: "2026-09-29T09:00:00.000Z" };
  const casey = lease({ id: "lease_casey", jointRoomGroupId: "jr1", bucket: "signed", status: "Manager Signature Pending", residentSignature: signed });
  const nora = lease({ id: "lease_nora", residentName: "Nora Vance", jointRoomGroupId: "jr1" });
  const other = lease({ id: "lease_other", residentName: "Someone Else", jointRoomGroupId: "jr2" });

  it("finds only the roommates on the same joint lease", () => {
    expect(jointRoomSiblings(casey, [casey, nora, other]).map((r) => r.id)).toEqual(["lease_nora"]);
    expect(jointRoomSiblings(lease({}), [casey, nora])).toEqual([]);
  });

  it("lists every roommate and keeps the Sign button away until all of them have signed", () => {
    const rows = leaseSignerRows(casey, { siblings: [nora] });
    expect(rows.map((r) => [r.role, r.name, r.state])).toEqual([
      ["Resident", "Casey Morgan", "signed"],
      ["Roommate", "Nora Vance", "sent"],
      ["You", "Manager", "waiting"],
    ]);
    expect(rows.find((r) => r.role === "You")?.action).toBeNull();
  });

  it("the manager countersigns only after every roommate has", () => {
    expect(jointRoomCountersignBlocker(casey, [casey, nora])).toMatch(/Waiting for Nora/);
    const noraSigned = { ...nora, bucket: "signed" as const, status: "Manager Signature Pending" as const, residentSignature: signed };
    expect(jointRoomAllResidentsSigned(casey, [casey, noraSigned])).toBe(true);
    expect(jointRoomCountersignBlocker(casey, [casey, noraSigned])).toBeNull();
    // an ordinary lease is never held
    expect(jointRoomCountersignBlocker(lease({}), [])).toBeNull();
  });

  it("when the manager can sign, the roommates' Sign button appears", () => {
    const noraSigned = { ...nora, bucket: "signed" as const, status: "Manager Signature Pending" as const, residentSignature: signed };
    const rows = leaseSignerRows(casey, { siblings: [noraSigned] });
    expect(rows.find((r) => r.role === "You")?.action).toBe("sign");
  });
});
