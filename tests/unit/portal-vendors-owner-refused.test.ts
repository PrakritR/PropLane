import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// An owner-only account now uses the normal Property portal, so the seam is no
// longer a refusal: refuseOwnerOnly always resolves null. The vendor routes
// still call it so a future view-only rule has one place to land.
describe("/api/portal-vendors keeps the owner seam, which no longer refuses", () => {
  const src = readFileSync("src/app/api/portal-vendors/route.ts", "utf8");
  it("still calls refuseOwnerOnly in GET and POST, and the helper never refuses", () => {
    expect(src.match(/refuseOwnerOnly\(db, user\.id\)/g)?.length).toBe(2);
    const helper = readFileSync("src/lib/property-owner/route-auth.server.ts", "utf8");
    expect(helper).toMatch(/export async function refuseOwnerOnly/);
    const body = helper.slice(helper.indexOf("export async function refuseOwnerOnly"));
    expect(body).toMatch(/return null/);
    expect(body).not.toMatch(/status: 403/);
    expect(body).not.toMatch(/status: 503/);
  });
});
