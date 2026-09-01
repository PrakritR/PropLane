import { describe, expect, it } from "vitest";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";
import { groupRowInputForRow } from "@/components/portal/application-group-section";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { buildResidentListClusters, buildResidentHouseClusters } from "@/lib/manager-resident-list-grouping";

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
        propertyId: row.propertyId ?? "",
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
          propertyId: lone.propertyId ?? "",
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

  it("clusters multiple placements for the same resident under one header", () => {
    const groups = buildApplicationGroups([]);
    const clusters = buildResidentListClusters(
      [
        {
          id: "RES-A1",
          name: "Jordan Lee",
          email: "jordan.lee@example.com",
          propertyId: "ballard",
          propertyLabel: "Ballard House",
          roomLabel: "Room 2",
          leaseStart: "2026-03-01",
          groupId: "",
        },
        {
          id: "RES-A2",
          name: "Jordan Lee",
          email: "jordan.lee@example.com",
          propertyId: "ballard",
          propertyLabel: "Ballard House",
          roomLabel: "Room 5",
          leaseStart: "2026-05-01",
          groupId: "",
        },
      ],
      groups,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("resident");
    if (clusters[0]?.kind === "resident") {
      expect(clusters[0].cluster.rows).toHaveLength(2);
      expect(clusters[0].cluster.rows.map((row) => row.roomLabel)).toEqual(["Room 2", "Room 5"]);
    }
  });

  it("clusters co-tenants at the same property under one house header", () => {
    const clusters = buildResidentHouseClusters([
      {
        id: "RES-1",
        name: "Mason Clark",
        email: "mason@example.com",
        propertyId: "ballard",
        propertyLabel: "Ballard House",
        roomLabel: "Room 2",
        leaseStart: "2026-09-01",
        groupId: "",
      },
      {
        id: "RES-2",
        name: "Riley Group Lead",
        email: "riley@example.com",
        propertyId: "ballard",
        propertyLabel: "Ballard House",
        roomLabel: "Room 2",
        leaseStart: "2026-09-01",
        groupId: "",
      },
      {
        id: "RES-3",
        name: "Sofia Diaz",
        email: "sofia@example.com",
        propertyId: "ballard",
        propertyLabel: "Ballard House",
        roomLabel: "Room 1",
        leaseStart: "2026-09-01",
        groupId: "",
      },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.propertyLabel).toBe("Ballard House");
    expect(clusters[0]?.rows).toHaveLength(3);
  });
});
