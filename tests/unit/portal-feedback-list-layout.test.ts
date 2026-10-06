import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/portal/portal-bug-feedback-panel.tsx"),
  "utf8",
);

describe("feedback list layout", () => {
  it("creates from the header's round +, not a dashed add row or a desktop table", () => {
    // The dashed bottom "+ Add" row is gone from every list: the header command
    // band's round blue + is the one create action (AGENTS.md § Portal UI system).
    expect(source).toContain("<PortalListControlStack");
    expect(source).toContain("<PortalPrimaryIconAction");
    expect(source).not.toContain("<PortalListAddRow");
    // The mobile-card list stays — this section never goes back to a table.
    expect(source).not.toContain("<table");
  });
});
