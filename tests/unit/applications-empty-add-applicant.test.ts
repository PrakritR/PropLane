/**
 * PLAN-0916-1353 — Applications empty Pending/Incomplete pill is Add applicant
 * (opens the wizard). Share-a-link stays on the header share glyph only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/components/portal/pro-applications.tsx"), "utf8");

describe("applications empty CTA is Add applicant", () => {
  it("the empty card on incomplete/pending says Add applicant and opens the wizard", () => {
    expect(src).toContain('label: "Add applicant"');
    expect(src).toContain('dataAttr: "applications-empty-add"');
    expect(src).toContain("setAddApplicationOpen(true)");
  });

  it("does not put Send application link on the empty card", () => {
    expect(src).not.toContain('dataAttr: "applications-empty-send"');
    const emptyBlock = src.slice(src.indexOf("emptyCard="), src.indexOf("onBulkClear="));
    expect(emptyBlock).not.toContain("Send application link");
    expect(emptyBlock).not.toContain("openSendApplicationInvite");
  });

  it("keeps Send application link on the header share glyph", () => {
    expect(src).toContain('data-attr="applications-send"');
    expect(src).toContain("openSendApplicationInvite");
  });
});
