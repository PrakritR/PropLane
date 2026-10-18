import { describe, expect, it } from "vitest";
import { groupServiceByCity, serviceRowFacts, type ServiceRow } from "@/components/portal/admin-service-panel";
import { serviceWorkspaceFinancesHref } from "@/lib/service/service-links";

const row = (over: Partial<ServiceRow>): ServiceRow => ({
  id: "1",
  name: "WS",
  city: null,
  ownerOfRecord: null,
  isDefault: false,
  houseCount: 0,
  workNumber: null,
  workNumberSource: null,
  teamCount: 1,
  viewerRole: "admin",
  canManage: true,
  ...over,
});

describe("Service list sections", () => {
  it("groups per city with Seattle first, the rest alphabetical, no city last", () => {
    const groups = groupServiceByCity([
      row({ id: "a", city: "Portland" }),
      row({ id: "b", city: null }),
      row({ id: "c", city: "seattle" }),
      row({ id: "d", city: "Austin" }),
      row({ id: "e", city: "Seattle " }),
    ]);
    expect(groups.map((g) => [g.city, g.rows.map((r) => r.id)])).toEqual([
      ["seattle", ["c", "e"]],
      ["Austin", ["d"]],
      ["Portland", ["a"]],
      [null, ["b"]],
    ]);
  });

  it("row facts: houses, the number it texts from, team", () => {
    expect(serviceRowFacts(row({ houseCount: 2, workNumber: "+12065550100", teamCount: 3 })).map((f) => (typeof f === "string" ? f : f.label))).toEqual([
      "2 houses",
      "+12065550100",
      "3 on team",
    ]);
    expect(serviceRowFacts(row({ viewerRole: null })).map((f) => (typeof f === "string" ? f : f.label))).toContain("Not on team");
  });

  it("leaves the Finances link slot empty until W17 fills it", () => {
    expect(serviceWorkspaceFinancesHref("x")).toBeNull();
  });
});
