// Leases read Draft · Sent · Signed; Applications read Pending · Approved · Declined.
// Incomplete and Withdrawn are facts on a Pending row, and the words people type land on the real route ids.
import { describe, expect, it } from "vitest";
import {
  APPLICATION_BUCKETS,
  LEASE_PIPELINE_TABS,
  parseApplicationBucket,
  parseApplicationListTab,
  parseLeasePipelineTab,
  parseApplicationDetailTab,
  parseLeaseDetailTab,
  applicationDetailHref,
} from "@/lib/portal-detail-routes";
import { countLeaseListTabs, leaseRowMatchesListTab, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const row = (over: Partial<LeasePipelineRow>): LeasePipelineRow =>
  ({ id: "l", residentName: "A", residentEmail: "a@x.com", unit: "u", stageLabel: "", updated: "", bucket: "manager", status: "Draft", pdfVersion: 1, notes: "", thread: [], ...over }) as LeasePipelineRow;

describe("lease list stages", () => {
  const draft = row({ id: "d", bucket: "manager", status: "Draft" });
  const waitingOnResident = row({ id: "r", bucket: "resident", status: "Resident Signature Pending" });
  const waitingOnYou = row({ id: "m", bucket: "signed", status: "Manager Signature Pending" });
  const done = row({ id: "s", bucket: "signed", status: "Fully Signed" });
  const rows = [draft, waitingOnResident, waitingOnYou, done];

  it("Sent holds every lease out for signature, whoever's turn it is", () => {
    expect(rows.filter((r) => leaseRowMatchesListTab(r, "resident")).map((r) => r.id)).toEqual(["r", "m"]);
    expect(rows.filter((r) => leaseRowMatchesListTab(r, "manager")).map((r) => r.id)).toEqual(["d"]);
    expect(rows.filter((r) => leaseRowMatchesListTab(r, "completed")).map((r) => r.id)).toEqual(["s"]);
  });

  it("an old /leases/signed link reads as Sent", () => {
    expect(rows.filter((r) => leaseRowMatchesListTab(r, "signed")).map((r) => r.id)).toEqual(["r", "m"]);
  });

  it("counts match the three tabs", () => {
    expect(countLeaseListTabs(rows)).toEqual({ manager: 1, resident: 2, completed: 1 });
  });
});

describe("route words", () => {
  it("Draft, Sent and Executed land on the lease route ids", () => {
    expect(parseLeasePipelineTab("draft")).toBe("manager");
    expect(parseLeasePipelineTab("sent")).toBe("resident");
    expect(parseLeasePipelineTab("executed")).toBe("completed");
    expect(parseLeasePipelineTab("completed")).toBe("completed");
    expect(LEASE_PIPELINE_TABS).toContain("signed");
  });

  it("the Applications buckets are Pending, Approved, Declined", () => {
    expect([...APPLICATION_BUCKETS]).toEqual(["pending", "approved", "rejected"]);
    expect(parseApplicationListTab("incomplete")).toBe("pending");
    expect(parseApplicationListTab("withdrawn")).toBe("pending");
    expect(parseApplicationListTab("declined")).toBe("rejected");
    expect(parseApplicationBucket("incomplete")).toBe("pending");
    expect(parseApplicationBucket("nonsense")).toBe("pending");
  });

  it("an application record is Application · Background check · Communication", () => {
    expect(parseApplicationDetailTab(undefined)).toBe("overview");
    expect(parseApplicationDetailTab("application-form")).toBe("overview");
    expect(parseApplicationDetailTab("background-check")).toBe("screening");
    expect(applicationDetailHref("/portal", "pending", "A1")).toBe("/portal/applications/pending/A1");
    expect(applicationDetailHref("/portal", "pending", "A1", "screening")).toBe("/portal/applications/pending/A1/screening");
  });

  it("a lease record keeps its old section links working by landing on the Lease section", () => {
    for (const old of [
      "lease-document",
      "terms",
      "signatures",
      "amendments",
      "payments",
      "documents",
      "audit-trail",
      "answers",
    ]) {
      expect(parseLeaseDetailTab(old)).toBe("overview");
    }
  });
});
