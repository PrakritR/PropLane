// C066/C281 follow-up — "Audit trail" and "Answers" are real sections on the
// manager lease record page, registered in the shared record-sections.ts
// registry after the Lease section (who signed + the lease itself). The page
// hides them (`hiddenSections`) until a lease carries execution evidence or a
// lease-first answer set, so an ordinary draft shows Lease · Communication.
import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";
import { leaseFirstAnswersSummaryLabel } from "@/lib/leasing/lease-first-signing-document";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

describe("manager lease record page — Audit trail and Answers tabs", () => {
  it("lists the Lease section first, then Audit trail and Answers, in the Lease group", () => {
    const sections = recordSections("manager", "lease", { basePath: "/portal" });
    const leaseGroup = sections.groups.find((g) => g.label === "Lease")!;
    const ids = leaseGroup.items.map((item) => item.id);
    expect(ids).toEqual(["overview", "audit-trail", "answers"]);
    expect(leaseGroup.items[0]!.label).toBe("Lease");
  });

  it("an ordinary draft shows only Lease · Communication", () => {
    const sections = recordSections("manager", "lease", { basePath: "/portal", hiddenSections: ["audit-trail", "answers"] });
    const ids = sections.groups.flatMap((g) => g.items.map((item) => item.id));
    expect(ids).toEqual(["overview", "communication"]);
  });

  it("both tabs' hrefs resolve under the lease detail route, distinct from the Lease section", () => {
    const sections = recordSections("manager", "lease", { basePath: "/portal", leaseListTab: "completed" });
    const leaseGroup = sections.groups.find((g) => g.label === "Lease")!;
    const auditTrail = leaseGroup.items.find((item) => item.id === "audit-trail")!;
    const answers = leaseGroup.items.find((item) => item.id === "answers")!;
    expect(auditTrail.href("lz_codom")).toBe("/portal/leases/completed/lz_codom/audit-trail");
    expect(answers.href("lz_codom")).toBe("/portal/leases/completed/lz_codom/answers");
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
    // A blank/whitespace answer must not count — same rule as the full tab.
    expect(leaseFirstAnswersSummaryLabel(config(), { la_ack_1: "  " })).toBe("0 of 3");
  });
});
