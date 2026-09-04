import { describe, expect, it, vi } from "vitest";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { attachManagerNamesToWorkOrders } from "@/lib/work-order-manager-names.server";

/**
 * The vendor work-order row carries `managerUserId` but never a name, so the
 * vendor's Payments screen rendered its fallback — "Property manager" — on
 * every row. A vendor working for TWO managers could not tell whose invoice was
 * whose, which is the whole purpose of that screen (PRP-252).
 */
function fakeDb(profiles: { id: string; full_name: string | null }[]) {
  const inCall = vi.fn();
  return {
    db: {
      from() {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) => {
              inCall(ids);
              return Promise.resolve({
                data: profiles.filter((p) => ids.includes(p.id)),
                error: null,
              });
            },
          }),
        };
      },
    } as never,
    inCall,
  };
}

const row = (id: string, managerUserId?: string) =>
  ({ id, managerUserId }) as DemoManagerWorkOrderRow;

describe("attachManagerNamesToWorkOrders", () => {
  it("names each row's own manager, so two managers are distinguishable", async () => {
    const { db } = fakeDb([
      { id: "mgr-a", full_name: "Ada Owner" },
      { id: "mgr-b", full_name: "Ben Owner" },
    ]);
    const out = await attachManagerNamesToWorkOrders(db, [row("w1", "mgr-a"), row("w2", "mgr-b")]);
    expect(out.map((r) => r.managerName)).toEqual(["Ada Owner", "Ben Owner"]);
  });

  it("reads profiles ONCE for the page, not per row", async () => {
    // Egress is a stated constraint; a per-row join would be N queries on a list.
    const { db, inCall } = fakeDb([{ id: "mgr-a", full_name: "Ada Owner" }]);
    await attachManagerNamesToWorkOrders(db, [row("w1", "mgr-a"), row("w2", "mgr-a"), row("w3", "mgr-a")]);
    expect(inCall).toHaveBeenCalledTimes(1);
    expect(inCall).toHaveBeenCalledWith(["mgr-a"]);
  });

  it("leaves a nameless manager alone so the client fallback still applies", async () => {
    const { db } = fakeDb([{ id: "mgr-a", full_name: "   " }]);
    const [out] = await attachManagerNamesToWorkOrders(db, [row("w1", "mgr-a")]);
    expect(out?.managerName).toBeUndefined();
  });

  it("does not query at all when no row names a manager", async () => {
    const { db, inCall } = fakeDb([]);
    const out = await attachManagerNamesToWorkOrders(db, [row("w1"), row("w2")]);
    expect(inCall).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });
});
