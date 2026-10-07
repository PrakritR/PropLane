import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// An owner-only account holds the manager role row to host /portal/owner. The
// vendor directory returns other managers' shared vendors (name, phone, email),
// so both verbs must refuse it.
describe("/api/portal-vendors refuses a Property owner", () => {
  const src = readFileSync("src/app/api/portal-vendors/route.ts", "utf8");
  it("refuses in GET and POST, and answers 503 when the membership cannot be read", () => {
    expect(src.match(/refuseOwnerOnly\(db, user\.id\)/g)?.length).toBe(2);
    const helper = readFileSync("src/lib/property-owner/route-auth.server.ts", "utf8");
    expect(helper).toMatch(/export async function refuseOwnerOnly[\s\S]*status: 403/);
    expect(helper).toMatch(/export async function refuseOwnerOnly[\s\S]*status: 503/);
  });
});
