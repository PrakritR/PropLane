import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// An owner-only account holds the manager role row to host /portal/owner. The
// vendor directory returns other managers' shared vendors (name, phone, email),
// so both verbs must refuse it.
describe("/api/portal-vendors refuses a Property owner", () => {
  const src = readFileSync("src/app/api/portal-vendors/route.ts", "utf8");
  it("checks ownerOnly in GET and POST", () => {
    expect(src.match(/ownerAccessStateFor\(db, user\.id\)\)\.ownerOnly/g)?.length).toBe(2);
  });
});
