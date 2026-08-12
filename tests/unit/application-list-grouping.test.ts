import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  buildApplicationListClusters,
  orderApplicationRowsWithHouseholds,
} from "@/lib/rental-application/application-list-grouping";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";
import { groupRowInputForRow } from "@/components/portal/application-group-section";

const GROUP_ID = "PROPLANE-CLUSTER01";

function application(over: Partial<RentalWizardFormState>): RentalWizardFormState {
  return {
    applyingAsGroup: "yes",
    groupRole: "first",
    groupSize: "3",
    groupId: GROUP_ID,
    ...over,
  } as RentalWizardFormState;
}

function row(id: string, name: string, role: "first" | "joining"): DemoApplicantRow {
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
    property: "The Pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted",
    application: application({ groupRole: role, groupSize: role === "first" ? "3" : "" }),
  };
}

describe("application list grouping", () => {
  it("keeps household members adjacent with the organizer first", () => {
    const rows = [row("AXIS-3", "Sam", "joining"), row("AXIS-1", "Jordan", "first"), row("AXIS-2", "Priya", "joining")];
    const ordered = orderApplicationRowsWithHouseholds(rows, "pending");
    expect(ordered.map((r) => r.id)).toEqual(["AXIS-1", "AXIS-2", "AXIS-3"]);
  });

  it("clusters households with two or more members in the same bucket", () => {
    const rows = [row("AXIS-1", "Jordan", "first"), row("AXIS-2", "Priya", "joining")];
    const groups = buildApplicationGroups(rows.map((r) => groupRowInputForRow(r)));
    const clusters = buildApplicationListClusters(rows, groups, "pending");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("household");
    if (clusters[0]?.kind === "household") {
      expect(clusters[0].rows.map((r) => r.id)).toEqual(["AXIS-1", "AXIS-2"]);
    }
  });

  it("leaves a lone group member as a single row cluster when the household is only one person", () => {
    const only = row("AXIS-9", "Alex", "joining");
    const groups = buildApplicationGroups([groupRowInputForRow(only)]);
    const clusters = buildApplicationListClusters([only], groups, "pending");
    expect(clusters).toEqual([{ kind: "single", row: only }]);
  });

  it("uses a household cluster for one bucket member when the group spans tabs", () => {
    const approved = {
      ...row("AXIS-1", "Jordan", "first"),
      bucket: "approved" as const,
      stage: "Approved",
    };
    const groups = buildApplicationGroups([
      groupRowInputForRow(approved),
      groupRowInputForRow(row("AXIS-2", "Priya", "joining")),
    ]);
    const clusters = buildApplicationListClusters([approved], groups, "approved");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.kind).toBe("household");
    if (clusters[0]?.kind === "household") {
      expect(clusters[0].rows).toHaveLength(1);
      expect(clusters[0].rows[0]?.id).toBe("AXIS-1");
      expect(clusters[0].group?.totalCount).toBe(2);
    }
  });
});
