import { describe, expect, it, vi } from "vitest";
import { ensureProfileProplaneId } from "@/lib/manager-access-server";

describe("ensureProfileProplaneId", () => {
  it("returns an existing PropLane ID without writing", async () => {
    const update = vi.fn();
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                manager_id: "PROPLANE-ABCDEF01",
                full_name: "Test Manager",
                email: "mgr@test.com",
                role: "manager",
              },
              error: null,
            }),
          })),
        })),
        update: vi.fn(() => ({
          eq: update,
        })),
      })),
    } as never;

    const result = await ensureProfileProplaneId(db, "user-1");
    expect(result).toEqual({
      ok: true,
      proplaneId: "PROPLANE-ABCDEF01",
      fullName: "Test Manager",
      email: "mgr@test.com",
      role: "manager",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("mints a PropLane ID when the profile row has none", async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { manager_id: null, full_name: null, email: "mgr@test.com", role: "manager" },
              error: null,
            }),
          })),
        })),
        update: vi.fn(() => ({
          eq: updateEq,
        })),
      })),
    } as never;

    const result = await ensureProfileProplaneId(db, "user-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proplaneId).toMatch(/^PROPLANE-[0-9A-F]{8}$/);
    }
    expect(updateEq).toHaveBeenCalledWith("id", "user-1");
  });
});
