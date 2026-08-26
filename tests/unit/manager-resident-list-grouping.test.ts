import { describe, expect, it } from "vitest";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";
import { groupRowInputForRow } from "@/components/portal/application-group-section";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { buildResidentListClusters } from "@/lib/manager-resident-list-grouping";

const GROUP_ID = "PROPLANE-RESGRP01";

function application(over: Partial<RentalWizardFormState>): RentalWizardFormState {
  return {
    applyingAsGroup: "yes",
    groupRole: "first",
    groupSize: "4",
    groupId: GROUP_ID,
    ...over,
  } as RentalWizardFormState;
}

function appRow(id: string, name: string, role: "first" | "joining"): DemoApplicantRow {
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
    property: "5259 Brooklyn Ave NE",
    stage: "Approved",
    bucket: "approved",
    detail: "",
    application: application({ groupRole: role, groupSize: role === "first" ? "4" : "" }),
  };
}

describe("manager-resident-list-grouping", () => {
  it("clusters approved residents who share a group id", () => {
    const apps = [
      appRow("RES-1", "Alex Kim", "first"),
      appRow("RES-2", "Jamie Lee", "joining"),
      appRow("RES-3", "Sam Park", "joining"),
    ];
    const groups = buildApplicationGroups(apps.map((row) => groupRowInputForRow(row)));
    const clusters = buildResidentListClusters(
      apps.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        propertyLabel: row.property,
        roomLabel: `Room ${row.id.split("-")[1]}`,
        leaseStart: "2026-09-01",
        groupId: GROUP_ID,
      })),
      groups,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("household");
    if (clusters[0]?.kind === "household") {
      expect(clusters[0].rows).toHaveLength(3);
    }
  });

  it("keeps unrelated residents as separate identity clusters", () => {
    const lone = appRow("RES-9", "Taylor Fox", "joining");
    const groups = buildApplicationGroups([groupRowInputForRow(lone)]);
    const clusters = buildResidentListClusters(
      [
        {
          id: lone.id,
          name: lone.name,
          email: lone.email,
          propertyLabel: lone.property,
          roomLabel: "Room 9",
          leaseStart: "2026-09-01",
          groupId: "",
        },
      ],
      groups,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("resident");
  });
});
