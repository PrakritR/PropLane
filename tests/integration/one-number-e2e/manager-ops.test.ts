 
// A manager texts the PropLane line. "Who hasn't paid" is answered from the rent ledger of THEIR team only.
// "Text all 5257 residents ..." is previewed, sent only after a YES, once, and never to another team or to
// anyone who said STOP. The YES gate is the real one (classifier, SMS preview, write-tool pin).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import { executeWrite, makeWritableCtx, previewWrite } from "../../unit/tools/fake-agent-ctx";

const send = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/tools/domains/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/domains/messaging")>();
  return {
    ...actual,
    sendMessageTool: {
      ...actual.sendMessageTool,
      handler: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => {
        send.calls.push(input);
        return { reply: "ok" };
      }),
    },
  };
});
const optedOut = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/sms-consent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sms-consent")>("@/lib/sms-consent");
  return { ...actual, isPhoneOptedOut: vi.fn(async (_db: unknown, phone: string) => optedOut.has(phone)) };
});

import { broadcastToResidentsTool, listUnpaidRentTool } from "@/lib/tools/domains/manager-ops";
import { buildManagerSmsRegistry } from "@/lib/tools";
import { classifySmsConfirmationReply, renderPreviewForSms } from "@/lib/sms/agent-confirmation.server";

type Row = Record<string, unknown>;
const A = "manager_a";
const B = "manager_b";

const rowOf = (manager: string, data: Record<string, unknown>, extra: Row = {}): Row => ({ id: String(data.id), manager_user_id: manager, row_data: data, ...extra });
const charge = (id: string, manager: string, propertyId: string, over: Record<string, unknown> = {}): Row =>
  rowOf(manager, { id, kind: "rent", rentMonth: "2026-10", status: "pending", amountLabel: "$900.00", balanceLabel: "$900.00", residentEmail: `${id}@x.test`, residentName: id, residentUserId: null, propertyId, propertyLabel: propertyId, managerUserId: manager, ...over });
const resident = (id: string, manager: string, propertyId: string, over: Record<string, unknown> = {}): Row =>
  rowOf(manager, { id, bucket: "approved", stage: "Resident", name: id, email: `${id}@x.test`, propertyId, property: propertyId, managerUserId: manager, ...over }, { resident_email: `${id}@x.test` });
const house = (id: string, manager: string, title: string): Row => ({ id, manager_user_id: manager, status: "live", row_data: { title }, property_data: { title, address: title } });

const tables = (): Record<string, Row[]> => ({
  portal_household_charge_records: [
    charge("ann", A, "p_5257", { status: "paid" }), charge("ben", A, "p_5257"), charge("cy", A, "p_5259", { balanceLabel: "$400.00" }),
    charge("dee", B, "p_b1"), charge("eli", B, "p_b1", { status: "paid" }),
  ],
  manager_property_records: [house("p_5257", A, "5257 Brooklyn"), house("p_5259", A, "5259 Brooklyn"), house("p_b1", B, "9 Other St")],
  manager_application_records: [resident("r1", A, "p_5257"), resident("r2", A, "p_5257"), resident("r3", A, "p_5259"), resident("foreign", B, "p_b1")],
  profiles: [
    { id: "u1", email: "r1@x.test", phone: "+12065550101", phone_verified_at: "2026-01-01T00:00:00Z" },
    { id: "u2", email: "r2@x.test", phone: "+12065550102", phone_verified_at: "2026-01-01T00:00:00Z" },
    { id: "u3", email: "r3@x.test", phone: null, phone_verified_at: null },
  ],
});
const ctxFor = (t: Record<string, Row[]>, over: Partial<AgentContext> = {}) => makeWritableCtx(t, { landlordId: A, userId: A, ...over });

beforeEach(() => {
  send.calls.length = 0;
  optedOut.clear();
});

describe("who hasn't paid", () => {
  it("is computed by the tool from this team's ledger: counts, names and a total, never another team's", async () => {
    const { ctx } = ctxFor(tables());
    const out = (await listUnpaidRentTool.handler(ctx, { month: "2026-10" })) as { paidCount: number; unpaidCount: number; unpaid: Array<{ resident: string }>; unpaidTotal: string };
    expect(out).toMatchObject({ paidCount: 1, unpaidCount: 2, unpaidTotal: "$1,300" });
    expect(out.unpaid.map((u) => u.resident).sort()).toEqual(["ben", "cy"]);
    expect(JSON.stringify(out)).not.toMatch(/dee|eli/);
  });

  it("a teammate who holds one house sees only that house", async () => {
    const { ctx } = ctxFor(tables(), { workspace: { id: "ws1", name: "North", isDefault: false, narrowing: true, propertyIds: ["p_5257"] } });
    const out = (await listUnpaidRentTool.handler(ctx, { month: "2026-10" })) as { unpaid: Array<{ resident: string }> };
    expect(out.unpaid.map((u) => u.resident)).toEqual(["ben"]);
  });

  it("the other team asking gets its own answer", async () => {
    const { ctx } = ctxFor(tables(), { landlordId: B, userId: B });
    const out = (await listUnpaidRentTool.handler(ctx, { month: "2026-10" })) as { unpaid: Array<{ resident: string }> };
    expect(out.unpaid.map((u) => u.resident)).toEqual(["dee"]);
  });

  it("is a read tool on the manager's text catalog, so no YES is needed to ask", () => {
    expect(listUnpaidRentTool.kind).toBe("read");
    expect(buildManagerSmsRegistry().has("list_unpaid_rent")).toBe(true);
  });
});

describe("a broadcast waits for YES", () => {
  const input = { propertyId: "p_5257", message: "Water off Tuesday 9-12" };

  it("previews who it will reach, in a text a person can judge, and sends nothing yet", async () => {
    optedOut.add("+12065550102");
    const { ctx } = ctxFor(tables());
    const preview = await previewWrite(broadcastToResidentsTool, ctx, input);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const asText = renderPreviewForSms(preview.preview);
    expect(asText).toContain("Message 2 residents");
    expect(asText).toContain("By text: 1 of 2"); // one of them said STOP
    expect(asText).toContain("Water off Tuesday 9-12");
    expect(asText).toMatch(/Reply YES to confirm or NO to cancel\.$/);
    expect(send.calls).toEqual([]);
  });

  it("YES sends once through the one messaging path to re-derived recipients; asking again the same day sends nothing", async () => {
    const { ctx, store } = ctxFor(tables());
    expect(classifySmsConfirmationReply("YES")).toBe("confirm");
    const done = await executeWrite(broadcastToResidentsTool, ctx, input);
    expect(done).toMatchObject({ ok: true, reply: "Sent to 2 residents." });
    expect(send.calls).toHaveLength(1);
    expect((send.calls[0]!.toEmails as string[]).sort()).toEqual(["r1@x.test", "r2@x.test"]);
    expect((store.audit_log ?? []).filter((r) => r.action === "broadcast_to_residents")).toHaveLength(1);
    const again = await executeWrite(broadcastToResidentsTool, ctx, input);
    expect(again.reply).toMatch(/already went/);
    expect(send.calls).toHaveLength(1);
  });

  it("anything but an exact yes is not a confirmation, and NO cancels", () => {
    for (const body of ["yes I was wondering about parking", "ok", "yeah", "send it", ""]) expect(classifySmsConfirmationReply(body)).toBe("none");
    for (const body of ["Y", "yes", "Yes!", "YES."]) expect(classifySmsConfirmationReply(body)).toBe("confirm");
    for (const body of ["N", "no", "NO."]) expect(classifySmsConfirmationReply(body)).toBe("deny");
  });

  it("never reaches another team's house, even if its id is named", async () => {
    const { ctx } = ctxFor(tables());
    const preview = await previewWrite(broadcastToResidentsTool, ctx, { propertyId: "p_b1", message: "Hello" });
    expect(preview.ok).toBe(false);
    const done = await executeWrite(broadcastToResidentsTool, ctx, { propertyId: "p_b1", message: "Hello" });
    expect(done.ok).toBe(false);
    expect(send.calls).toEqual([]);
  });

  it("with several houses and none named, asks which; a teammate with one house is not asked", async () => {
    const { ctx } = ctxFor(tables());
    expect(await previewWrite(broadcastToResidentsTool, ctx, { message: "Hello" })).toEqual({ ok: false, error: "Which house: 5257 Brooklyn, 5259 Brooklyn, or all?" });
    const narrowed = ctxFor(tables(), { workspace: { id: "ws1", name: "North", isDefault: false, narrowing: true, propertyIds: ["p_5259"] } });
    expect((await previewWrite(broadcastToResidentsTool, narrowed.ctx, { message: "Hello" })).ok).toBe(true);
  });

  it("is a write tool with a preview, so the model can never send it without the gate", () => {
    expect(broadcastToResidentsTool.kind).toBe("write");
    expect(typeof broadcastToResidentsTool.preview).toBe("function");
  });
});
