import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-coordination.server", () => ({
  coordinationPreview: vi.fn(), coordinationVendorChoices: vi.fn(), listCoordination: vi.fn(),
  coordinationProposal: vi.fn(async () => ({ id: "repair", version: 2, status: "collecting", manager_takeover: false, work_order_id: "work", vendor_directory_id: "directory" })),
  applyCoordinationAction: vi.fn(async (_db, _actor, input) => ({ id: "consultation", version: 1, ...input })),
}));
import { smsCoordinationRecordTool } from "@/lib/tools/domains/vendor-coordination";
import { applyCoordinationAction } from "@/lib/vendor-coordination.server";
const base = { proposalId: "11111111-1111-4111-8111-111111111111", expectedVersion: 2, kind: "revise_quote" as const };
const quote = { laborUsd: "175.50", materialsUsd: "42", consultationFeeUsd: "0", scope: "Replace leaking toilet supply valve", exclusions: "Wall repairs excluded" };
describe("conversational quote tool boundary", () => {
  it("retains unknown money between turns rather than filling it with zero", () => {
    expect(smsCoordinationRecordTool.inputSchema.safeParse({ ...base, quote: { scope: quote.scope, laborUsd: "175.50" } }).success).toBe(false);
    expect(smsCoordinationRecordTool.inputSchema.safeParse({ ...base, quote: { ...quote, materialsUsd: "depends" } }).success).toBe(false);
    expect(smsCoordinationRecordTool.inputSchema.safeParse({ ...base, quote: { ...quote, laborUsd: "150-200" } }).success).toBe(false);
  });
  it("records only explicit exact terms and does not accept or book them", async () => {
    vi.mocked(applyCoordinationAction).mockClear();
    const input = smsCoordinationRecordTool.inputSchema.parse({ ...base, quote, durationMinutes: 60 });
    await smsCoordinationRecordTool.handler({ db: {}, landlordId: "owner", vendorScope: { vendorDirectoryId: "directory", vendorUserId: "vendor", workOrderId: "work" } } as never, input);
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
    expect(applyCoordinationAction).toHaveBeenCalledWith({}, expect.objectContaining({ role: "vendor" }), expect.objectContaining({ kind: "revise_quote", quote: { laborCents: 17550, materialsCents: 4200, consultationFeeCents: 0, scope: quote.scope, exclusions: quote.exclusions } }));
  });
  it("opens a paid consultation as a separate proposal and leaves approval required", async () => {
    vi.mocked(applyCoordinationAction).mockClear();
    const input = smsCoordinationRecordTool.inputSchema.parse({ ...base, kind: "propose_consultation", quote: { ...quote, laborUsd: "0", materialsUsd: "0", consultationFeeUsd: "75", scope: "Diagnostic visit only" }, durationMinutes: 30 });
    await smsCoordinationRecordTool.handler({ db: {}, landlordId: "owner", vendorScope: { vendorDirectoryId: "directory", vendorUserId: "vendor", workOrderId: "work", sourceMessageId: "SM1" } } as never, input);
    const actions = vi.mocked(applyCoordinationAction).mock.calls.map((call) => call[2]);
    expect(actions.map((a) => a.kind)).toEqual(["enroll", "revise_quote"]);
    expect(actions[0]).toMatchObject({ visit_type: "consultation" });
    expect(actions[1]).toMatchObject({ quote: { consultationFeeCents: 7500, scope: "Diagnostic visit only" } });
  });
});
