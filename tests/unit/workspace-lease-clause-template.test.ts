import { describe, expect, it } from "vitest";
import {
  emptyWorkspaceLeaseClauseTemplate,
  fillClauseSample,
  LEASE_TEMPLATE_VARIABLES,
  newLeaseClauseEntry,
  normalizeWorkspaceLeaseClauseTemplate,
} from "@/lib/lease-templates/workspace-lease-clause-template";

describe("workspace-lease-clause-template", () => {
  it("starts with no clauses", () => {
    expect(emptyWorkspaceLeaseClauseTemplate().clauses).toEqual([]);
  });

  it("fills every declared {variable} with its sample value", () => {
    const body = "Tenant {tenantFullName} pays {rentAmount} for {propertyAddress}.";
    const filled = fillClauseSample(body);
    for (const variable of LEASE_TEMPLATE_VARIABLES) {
      if (body.includes(`{${variable.key}}`)) {
        expect(filled).toContain(variable.sample);
        expect(filled).not.toContain(`{${variable.key}}`);
      }
    }
  });

  it("leaves an unknown placeholder untouched", () => {
    expect(fillClauseSample("See {notAVariable} above.")).toBe("See {notAVariable} above.");
  });

  it("normalizes a persisted blob back into clean clauses, dropping one with no id", () => {
    const normalized = normalizeWorkspaceLeaseClauseTemplate({
      clauses: [
        { id: "c1", title: "Quiet hours", body: "No noise after {leaseStartDate}." },
        { title: "Missing id — dropped", body: "x" },
      ],
    });
    expect(normalized?.clauses).toHaveLength(1);
    expect(normalized?.clauses[0]!.id).toBe("c1");
  });

  it("normalize returns null for a non-object", () => {
    expect(normalizeWorkspaceLeaseClauseTemplate(null)).toBeNull();
  });

  it("mints a fresh, empty clause for the given id", () => {
    const clause = newLeaseClauseEntry("c9");
    expect(clause).toEqual({ id: "c9", title: "New clause", body: "" });
  });
});
