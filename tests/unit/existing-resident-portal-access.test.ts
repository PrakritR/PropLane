import { describe, expect, it, vi } from "vitest";

/**
 * "Onboard an existing resident" is precisely the flow for a tenant who signed
 * on paper before PropLane, so having no PDF is the NORMAL case. The lease row
 * was then written with no signatures, the portal gate saw no signed lease, and
 * the stage resolved to `pre_approval` — so someone who already lives there and
 * pays rent was shown Tour and Application tabs and could not reach Payments,
 * Services, Lease or Documents at all (PRP-239).
 */
const rows = vi.hoisted(() => ({ data: [] as { row_data: Record<string, unknown> }[] }));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: async () => ({ data: rows.data }) }),
          order: async () => ({ data: rows.data }),
        }),
      }),
    }),
  }),
}));

import {
  loadResidentLeaseSignedStatus,
  loadResidentManagerAttestedTenancy,
} from "@/lib/resident-portal-access";

describe("a manager-attested tenancy unlocks the portal", () => {
  it("is recognised when the manager onboarded an existing resident", async () => {
    rows.data = [{ row_data: { managerAttestedTenancyAt: "2026-09-04T00:00:00Z" } }];
    await expect(loadResidentManagerAttestedTenancy("tenant@example.com")).resolves.toBe(true);
  });

  it("is NOT reported as a signed lease", async () => {
    // The document really is unsigned. Anything asking "is the lease signed"
    // must keep getting the truth — this only widens portal ACCESS.
    rows.data = [{ row_data: { managerAttestedTenancyAt: "2026-09-04T00:00:00Z" } }];
    await expect(loadResidentLeaseSignedStatus("tenant@example.com")).resolves.toBe(false);
  });

  it("is absent on an ordinary unsigned lease, so it cannot unlock a stranger", async () => {
    rows.data = [{ row_data: { bucket: "manager" } }];
    await expect(loadResidentManagerAttestedTenancy("tenant@example.com")).resolves.toBe(false);
  });

  it("ignores an empty attestation timestamp", async () => {
    rows.data = [{ row_data: { managerAttestedTenancyAt: "   " } }];
    await expect(loadResidentManagerAttestedTenancy("tenant@example.com")).resolves.toBe(false);
  });

  it("needs an email to answer at all", async () => {
    rows.data = [{ row_data: { managerAttestedTenancyAt: "2026-09-04T00:00:00Z" } }];
    await expect(loadResidentManagerAttestedTenancy("  ")).resolves.toBe(false);
  });
});

describe("the onboarding write stamps it", () => {
  it("marks the no-PDF branch, and does not fabricate signatures", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/lib/existing-resident-onboarding.server.ts"),
      "utf8",
    );
    const noPdfBranch = source.slice(source.indexOf('bucket: "manager"'), source.indexOf('bucket: "manager"') + 900);
    expect(noPdfBranch).toContain("managerAttestedTenancyAt: iso");
    // A signature records the SHA-256 of the document that party was shown, and
    // there is no document here — inventing one would be fabricated evidence.
    expect(noPdfBranch).not.toContain("managerSignature");
    expect(noPdfBranch).not.toContain("residentSignature");
    expect(noPdfBranch).not.toContain("externallySignedLease");
  });
});
