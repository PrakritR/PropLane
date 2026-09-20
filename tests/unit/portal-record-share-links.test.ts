import { describe, expect, it, vi } from "vitest";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import type { DemoApplicantRow } from "@/data/demo-portal";
const shareBoundaries = vi.hoisted(() => ({
  classification: vi.fn(),
  recordWorkspace: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: shareBoundaries.classification,
  lookupRecordTestWorkspaceId: shareBoundaries.recordWorkspace,
}));

import { buildPortalRecordShareUrl, createPortalRecordShareLink } from "@/lib/portal-record-share-links.server";
import { isSafeLeasePdfDataUrl } from "@/lib/portal-record-share-pdf";

describe("buildPortalRecordShareUrl", () => {
  it("builds lease and application public paths", () => {
    expect(buildPortalRecordShareUrl("https://prop-lane.space", "lease", "abc123")).toBe(
      "https://prop-lane.space/share/leases/abc123",
    );
    expect(buildPortalRecordShareUrl("https://prop-lane.space/", "application", "AXIS-1")).toBe(
      "https://prop-lane.space/share/applications/AXIS-1",
    );
  });
});

describe("createPortalRecordShareLink provenance", () => {
  it("refuses a classified record owner before inserting a public bearer token", async () => {
    shareBoundaries.classification
      .mockResolvedValueOnce({ kind: "classified", workspaceId: "workspace-a", role: "manager", state: "active" })
      .mockResolvedValueOnce({ kind: "normal" });
    shareBoundaries.recordWorkspace.mockResolvedValue(null);
    const insert = vi.fn();
    const db = { from: vi.fn(() => ({ insert })) };

    await expect(createPortalRecordShareLink(db as never, {
      recordKind: "application",
      recordId: "application-a",
      managerUserId: "private-owner",
      createdBy: "normal-admin",
    })).rejects.toThrow("unavailable");

    expect(insert).not.toHaveBeenCalled();
  });
});

describe("isSafeLeasePdfDataUrl", () => {
  it("accepts only base64 PDF data URLs", () => {
    expect(isSafeLeasePdfDataUrl("data:application/pdf;base64,JVBERi0x")).toBe(true);
    expect(isSafeLeasePdfDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeLeasePdfDataUrl("https://example.com/lease.pdf")).toBe(false);
  });
});

describe("buildApplicationHtml publicShare", () => {
  const row = {
    id: "AXIS-TEST-1",
    name: "Alex Applicant",
    property: "Oak House",
    bucket: "pending",
    application: {
      fullLegalName: "Alex Applicant",
      email: "alex@example.com",
      phone: "2065550100",
      dateOfBirth: "1990-01-01",
      ssn: "123456789",
      monthlyIncome: "5000",
      evictionHistory: "yes",
      evictionDetails: "Sensitive detail",
      applyingAsGroup: "yes",
      groupId: "AXISGRP-TEST-12345",
    },
  } as DemoApplicantRow;

  it("omits contact, financial, and screening fields from public share HTML", () => {
    const html = buildApplicationHtml(row, { publicShare: true });
    expect(html).toContain("Alex Applicant");
    expect(html).toContain("Oak House");
    expect(html).not.toContain("alex@example.com");
    expect(html).not.toContain("2065550100");
    expect(html).not.toContain("1990-01-01");
    expect(html).not.toContain("5000");
    expect(html).not.toContain("Sensitive detail");
    expect(html).not.toContain("Prior eviction");
    expect(html).not.toContain("AXISGRP-");
  });
});
