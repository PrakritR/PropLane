import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { DEFAULT_HOUSEMATE_SHARING } from "@/lib/resident-housemate-sharing";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })), updateAuditResult: vi.fn(async () => {}) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { readHousemateSharing, saveHousemateSharing } from "@/lib/resident-housemate-sharing.server";
let rows: Array<{ user_id: string; preferences: typeof DEFAULT_HOUSEMATE_SHARING }> = [];
const writes = vi.fn();
const db = { from: vi.fn((table: string) => {
  expect(table).toBe("resident_housemate_sharing");
  let id = "";
  const q = {
    select: () => q,
    eq: (key: string, value: string) => { expect(key).toBe("user_id"); id = value; return q; },
    maybeSingle: async () => ({ data: rows.find(row => row.user_id === id) ?? null, error: null }),
    upsert: async (row: typeof rows[number]) => { writes(row); rows = [...rows.filter(r => r.user_id !== row.user_id), row]; return { error: null }; },
  }; return q;
}) };
const ctx = (userId: string) => ({ kind: "resident", userId, landlordId: userId, db } as unknown as ResidentAgentContext);
beforeEach(() => { rows = [{ user_id: "resident-b", preferences: { ...DEFAULT_HOUSEMATE_SHARING, sharePhone: true } }]; vi.clearAllMocks(); });
describe("sharing preferences belong to the authenticated resident", () => {
  it("reads defaults for A without reading B's preferences", async () => {
    expect(await readHousemateSharing(ctx("resident-a"))).toEqual(DEFAULT_HOUSEMATE_SHARING);
    expect((await readHousemateSharing(ctx("resident-b"))).sharePhone).toBe(true);
  });
  it("saves only A and permits revoking earlier consent", async () => {
    await saveHousemateSharing(ctx("resident-a"), { ...DEFAULT_HOUSEMATE_SHARING, shareEmail: true });
    expect(writes.mock.calls[0][0].user_id).toBe("resident-a");
    expect((await readHousemateSharing(ctx("resident-b"))).sharePhone).toBe(true);
    await saveHousemateSharing(ctx("resident-a"), DEFAULT_HOUSEMATE_SHARING);
    expect(await readHousemateSharing(ctx("resident-a"))).toEqual(DEFAULT_HOUSEMATE_SHARING);
  });
  it("rejects identity injection before writing", async () => {
    await expect(saveHousemateSharing(ctx("resident-a"), { ...DEFAULT_HOUSEMATE_SHARING, user_id: "resident-b" })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });
});
