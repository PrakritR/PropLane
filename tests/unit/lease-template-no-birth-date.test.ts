import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import { leaseContextFromApplication } from "@/lib/generated-lease";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG, WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";

const DOB = "1998-03-14";

describe("lease templates print no birth date", () => {
  const app = { ...snapshotJordanLee(), dateOfBirth: DOB, ssn: "123-45-6789", driversLicense: "D1234567" };

  it.each([
    ["compact_room", WASHINGTON_LEASE_CONFIG],
    ["standard", { ...WASHINGTON_LEASE_CONFIG, documentStyle: "standard" as const }],
    ["seattle compact_room", SEATTLE_LEASE_CONFIG],
  ])("%s lease has no Date of birth line, date, SSN or licence even when the application carries them", (_label, config) => {
    const html = buildLeaseHtml(leaseContextFromApplication(app), config);
    expect(html.length).toBeGreaterThan(5000);
    expect(html).toContain(app.fullLegalName);
    expect(html).not.toMatch(/date of birth/i);
    expect(html).not.toContain(DOB);
    expect(html).not.toContain("123-45-6789");
    expect(html).not.toContain("D1234567");
  });

  it("neither template source reads a birth date any more", () => {
    for (const file of ["build-lease-html.ts", "build-compact-room-lease-html.ts"]) {
      const source = readFileSync(join(process.cwd(), "src/lib/lease-templates", file), "utf8");
      expect(source, file).not.toMatch(/date of birth/i);
      expect(source, file).not.toMatch(/tenantDob|dateOfBirth/);
    }
  });
});
