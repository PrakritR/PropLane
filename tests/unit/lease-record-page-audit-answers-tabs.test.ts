// CX-RC1 — manager lease record is Lease · Communication; audit trail and lease-first
// answers fold into the Lease section (studio After), not separate rail tabs.
import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";
import { parseLeaseDetailTab } from "@/lib/portal-detail-routes";
import { leaseFirstAnswersSummaryLabel } from "@/lib/leasing/lease-first-signing-document";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

describe("manager lease record page — CX-RC1 rail", () => {
  it("lists only Lease and Communication", () => {
    const sections = recordSections("manager", "lease", { basePath: "/portal" });
    const ids = sections.groups.flatMap((g) => g.items.map((item) => item.id));
    expect(ids).toEqual(["overview", "communication"]);
    const leaseGroup = sections.groups.find((g) => g.label === "Lease")!;
    expect(leaseGroup.items[0]!.label).toBe("Lease");
  });

  it("legacy audit-trail and answers URLs resolve to the Lease section", () => {
    expect(parseLeaseDetailTab("audit-trail")).toBe("overview");
    expect(parseLeaseDetailTab("answers")).toBe("overview");
  });

  it("has unique section ids (no collision with an existing tab)", () => {
    const sections = recordSections("manager", "lease", { basePath: "/portal" });
    const allIds = sections.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

const FIELDS: ManagerCustomApplicationField[] = [
  { id: "f1", key: "la_ack_1", label: "Ack one", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f2", key: "la_ack_2", label: "Ack two", type: "initials", required: true, options: [], section: "Acknowledgements" },
  { id: "f3", key: "la_fee", label: "Monthly fee", type: "currency", required: true, options: [], section: "I. Fees", filledBy: "manager" },
];

function config(): ApplicationTemplateQuestionConfig {
  return {
    disabledStandardApplicationKeys: [],
    customApplicationFields: FIELDS,
    applicationConfigMode: "custom",
    version: 1,
    questionDisplayOrder: FIELDS.map((f) => f.id),
  };
}

describe("leaseFirstAnswersSummaryLabel — the Overview card's one-line summary", () => {
  it("counts every answered clause, across all types, never just initials", () => {
    expect(leaseFirstAnswersSummaryLabel(config(), { la_ack_1: "JR", la_fee: "$900" })).toBe("2 of 3");
  });

  it("reads 0 of N when nothing has been answered yet", () => {
    expect(leaseFirstAnswersSummaryLabel(config(), {})).toBe("0 of 3");
  });

  it("agrees with leaseFirstAnswersBySection on what counts as answered", () => {
    expect(leaseFirstAnswersSummaryLabel(config(), { la_ack_1: "  " })).toBe("0 of 3");
  });
});
