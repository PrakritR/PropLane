import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/portal/portal-bug-feedback-panel.tsx"),
  "utf8",
);

describe("feedback list layout", () => {
  it("uses the portal's dashed add row, not a desktop feedback table", () => {
    // Feedback briefly dropped its dashed add row; "restore dashed add rows on
    // all manager list sections" put it back, so this section now follows the
    // same add affordance as every other portal list.
    expect(source).toContain("<PortalListAddRow");
    // The mobile-card list stays — this section never goes back to a table.
    expect(source).not.toContain("<table");
  });
});
