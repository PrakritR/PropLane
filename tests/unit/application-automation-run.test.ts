/**
 * The post-approval ladder: generate, then send — each step only if the manager enabled it AND
 * the manual path's own gate would have allowed it.
 *
 * The dangerous failure is a send that skips `leaseSendGateBlocker`, because that puts an
 * unreviewed or mismatched lease in front of a resident for signature at machine speed. These
 * tests pin that the gate is consulted with the row as it stands AFTER generation, not before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_AUTOMATION } from "@/lib/application-automation-preferences";

const generateLeaseHtmlForRow = vi.fn();
const sendLeaseToResident = vi.fn();
const leaseSendGateBlocker = vi.fn();
const readLeasePipeline = vi.fn();

vi.mock("@/lib/lease-pipeline-storage", () => ({
  generateLeaseHtmlForRow: (...a: unknown[]) => generateLeaseHtmlForRow(...a),
  sendLeaseToResident: (...a: unknown[]) => sendLeaseToResident(...a),
  leaseSendGateBlocker: (...a: unknown[]) => leaseSendGateBlocker(...a),
  readLeasePipeline: (...a: unknown[]) => readLeasePipeline(...a),
}));

const { runPostApprovalAutomation } = await import("@/lib/application-automation-run.client");

type Row = Record<string, unknown>;

const ROW: Row = {
  id: "lease_app_A1",
  primaryApplicationId: "A1",
  residentEmail: "sohan@example.com",
  status: "Manager Review",
  updatedAtIso: "2026-08-24T00:00:00.000Z",
};

function pipeline(...rows: Row[]) {
  readLeasePipeline.mockReturnValue(rows);
}

const ALL_ON = {
  ...DEFAULT_APPLICATION_AUTOMATION,
  autoGenerateLease: true,
  autoSendLease: true,
};

const base = {
  applicationId: "A1",
  residentEmail: "sohan@example.com",
  managerUserId: "mgr-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  leaseSendGateBlocker.mockReturnValue(null);
  generateLeaseHtmlForRow.mockReturnValue({ ok: true, version: 2 });
  sendLeaseToResident.mockResolvedValue({ ok: true });
});

describe("post-approval automation", () => {
  it("does nothing at all when the manager enabled nothing", async () => {
    pipeline(ROW);
    const result = await runPostApprovalAutomation({
      ...base,
      prefs: DEFAULT_APPLICATION_AUTOMATION,
    });
    expect(result.steps).toEqual([]);
    // Not even a lookup — an untouched manager's approval keeps its old code path exactly.
    expect(readLeasePipeline).not.toHaveBeenCalled();
    expect(generateLeaseHtmlForRow).not.toHaveBeenCalled();
    expect(sendLeaseToResident).not.toHaveBeenCalled();
  });

  it("generates then sends when both are on and nothing blocks", async () => {
    // Generation writes the document, so the second read must show it or the send is skipped.
    readLeasePipeline
      .mockReturnValueOnce([ROW])
      .mockReturnValue([{ ...ROW, generatedHtml: "<html>lease</html>" }]);

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(generateLeaseHtmlForRow).toHaveBeenCalledWith("lease_app_A1", "mgr-1");
    expect(sendLeaseToResident).toHaveBeenCalledWith("lease_app_A1", "mgr-1");
    expect(result.steps).toEqual([
      { step: "generate", ran: true },
      { step: "send", ran: true },
    ]);
  });

  it("NEVER sends when the send gate refuses, and reports the gate's own message", async () => {
    pipeline({ ...ROW, generatedHtml: "<html>lease</html>" });
    leaseSendGateBlocker.mockReturnValue("Review the imported lease before sending it.");

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(sendLeaseToResident).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual({
      step: "send",
      ran: false,
      reason: "gate_blocked",
      detail: "Review the imported lease before sending it.",
    });
  });

  it("judges the send gate on the row AFTER generation", async () => {
    // Reading the gate against the pre-generation row would ask "may I send this?" of a row with
    // no document — the wrong question, and one that can answer differently.
    readLeasePipeline
      .mockReturnValueOnce([ROW])
      .mockReturnValue([{ ...ROW, generatedHtml: "<html>lease</html>" }]);

    await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(leaseSendGateBlocker).toHaveBeenCalledTimes(1);
    expect(leaseSendGateBlocker.mock.calls[0]![0]).toMatchObject({
      generatedHtml: "<html>lease</html>",
    });
  });

  it("does not regenerate a lease that already has a document", async () => {
    // Regenerating could replace a document a resident already signed.
    pipeline({ ...ROW, generatedHtml: "<html>existing</html>" });

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(generateLeaseHtmlForRow).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual({ step: "generate", ran: false, reason: "already_done" });
    // But it still sends the document that exists.
    expect(sendLeaseToResident).toHaveBeenCalled();
  });

  it("does not send a lease that already went out", async () => {
    pipeline({
      ...ROW,
      generatedHtml: "<html>lease</html>",
      sentToResidentAt: "2026-08-20T00:00:00.000Z",
    });

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(sendLeaseToResident).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual({ step: "send", ran: false, reason: "already_done" });
  });

  it("says there is nothing to send rather than blaming the gate", async () => {
    // Generation off and no document: the honest reason is "no document yet".
    pipeline(ROW);

    const result = await runPostApprovalAutomation({
      ...base,
      prefs: { ...DEFAULT_APPLICATION_AUTOMATION, autoSendLease: true },
    });

    expect(leaseSendGateBlocker).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual({
      step: "send",
      ran: false,
      reason: "gate_blocked",
      detail: "No lease document to send yet.",
    });
  });

  it("skips everything for a withdrawn application", async () => {
    pipeline({ ...ROW, generatedHtml: "<html>lease</html>" });

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON, isWithdrawn: true });

    expect(generateLeaseHtmlForRow).not.toHaveBeenCalled();
    expect(sendLeaseToResident).not.toHaveBeenCalled();
    expect(result.steps.every((s) => !s.ran)).toBe(true);
  });

  it("never writes in demo mode", async () => {
    pipeline({ ...ROW, generatedHtml: "<html>lease</html>" });

    await runPostApprovalAutomation({ ...base, prefs: ALL_ON, isDemo: true });

    expect(generateLeaseHtmlForRow).not.toHaveBeenCalled();
    expect(sendLeaseToResident).not.toHaveBeenCalled();
  });

  it("stops cleanly when approval produced no lease row", async () => {
    pipeline();
    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });
    expect(result.leaseId).toBeNull();
    expect(generateLeaseHtmlForRow).not.toHaveBeenCalled();
  });

  it("reports a generation failure instead of sending an empty lease", async () => {
    pipeline(ROW);
    generateLeaseHtmlForRow.mockReturnValue({ ok: false, error: "No application data on file." });

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(result.steps).toContainEqual({
      step: "generate",
      ran: false,
      reason: "gate_blocked",
      detail: "No application data on file.",
    });
    expect(sendLeaseToResident).not.toHaveBeenCalled();
  });

  it("matches the lease by application id, not just by email", async () => {
    // A returning resident has older rows; the one this approval produced is the target.
    pipeline(
      { ...ROW, id: "old-lease", primaryApplicationId: "A0", updatedAtIso: "2026-01-01T00:00:00.000Z" },
      { ...ROW, id: "new-lease", primaryApplicationId: "A1" },
    );

    const result = await runPostApprovalAutomation({ ...base, prefs: ALL_ON });

    expect(result.leaseId).toBe("new-lease");
  });
});
