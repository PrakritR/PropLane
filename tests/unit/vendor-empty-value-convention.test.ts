import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C267: "Not set" is the app's one empty-value word for a text fact (C254's
 * shared vendor-detail `fact()` helper already uses it). The vendor
 * directory/list rows still showed "—" for a missing trade — the same class
 * of empty text field, not the exempted count/rating/money state — which
 * read as a second, inconsistent convention on the same page.
 */
const src = readFileSync("src/components/portal/pro-vendors-panel.tsx", "utf8");

describe("Vendors directory empty-value convention", () => {
  it("shows Not set for a missing trade, not a dash", () => {
    expect(src).toContain('row.trade.trim() || "Not set"');
    expect(src).toContain('tradesLabel || "Not set"');
    expect(src).not.toContain('row.trade.trim() || "—"');
    expect(src).not.toContain('tradesLabel || "—"');
  });
});
