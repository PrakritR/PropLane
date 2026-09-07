/**
 * PRP-357 / PRP-370: canonical portfolio seed must reclaim profiles.manager_id
 * from a stale holder before upserting the resident (unique constraint).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("canonical demo portfolio axis reclaim (PRP-357)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/demo/canonical-demo-portfolio-db.ts"),
    "utf8",
  );

  it("clears manager_id from any other profile before the resident upsert", () => {
    expect(src).toMatch(/async function reclaimResidentAxisId/);
    expect(src).toMatch(/\.eq\("manager_id", axisId\)/);
    expect(src).toMatch(/\.neq\("id", ctx\.residentUserId\)/);
    expect(src).toMatch(/\.update\(\{\s*manager_id:\s*null\s*\}\)/);
    expect(src).toMatch(/await reclaimResidentAxisId\(\);\s*\n\s*await must\(/);
  });
});
