import { describe, expect, it } from "vitest";
import {
  clusterManagerResidentListRows,
  residentHousingMeta,
} from "@/lib/manager-resident-list";

describe("manager-resident-list", () => {
  it("clusters residents by email like payments", () => {
    const rows = [
      {
        id: "res-1",
        name: "Alex Kim",
        email: "alex@example.com",
        propertyLabel: "Oak House",
        roomLabel: "Room 1",
        leaseStart: "2026-09-01",
      },
      {
        id: "res-2",
        name: "Jamie Lee",
        email: "jamie@example.com",
        propertyLabel: "Oak House",
        roomLabel: "Room 2",
        leaseStart: "2026-09-01",
      },
    ];
    const clusters = clusterManagerResidentListRows(rows);
    expect(clusters).toHaveLength(2);
    expect(residentHousingMeta(rows[0]!, false)).toBe("Room 1");
    expect(residentHousingMeta(rows[0]!, true)).toBe("Room 1 · Oak House");
  });
});
