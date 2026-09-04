/**
 * AXI-160 — "update sie of add tour to be consistent across all the tabs".
 *
 * Tours was the one tab whose ADD row did not match the rest. It forced the
 * compact inline footer at EVERY state (so an empty Tours list showed a small
 * row where every other empty tab shows the full dashed block) and re-styled the
 * label to normal-case text-sm, dropping the uppercase + letter-spacing the
 * house row uses.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const tours = read("src/components/portal/pro-tours.tsx");
const css = read("src/app/globals.css");
const surface = read("src/components/portal/portal-record-list-surface.tsx");

describe("Add tour matches every other tab's ADD row", () => {
  it("drops the bespoke tour class entirely", () => {
    expect(tours).not.toContain("portal-list-add-row--tour");
    expect(css).not.toContain("portal-list-add-row--tour");
  });

  it("no longer forces the compact footer at every state", () => {
    const add = tours.split('ariaLabel: "Schedule tour"')[1]?.split("}}")[0] ?? "";
    expect(add).not.toContain("inline: true");
  });

  it("no longer overrides the house label typography", () => {
    // Assert on the absence of a `className` override rather than on style
    // strings — the explanatory comment beside it names them, so a substring
    // search matches the comment and passes for the wrong reason.
    const add = tours.split('ariaLabel: "Schedule tour"')[1]?.split("}}")[0] ?? "";
    expect(add).not.toContain("className:");
  });

  it("still renders an Add tour affordance", () => {
    expect(tours).toContain('label: "Add tour"');
    expect(tours).toContain('dataAttr: "tours-list-add"');
  });

  it("leaves the shared inline-when-nonempty rule as the default", () => {
    expect(surface).toContain("add.inline ?? !isEmpty");
  });
});
