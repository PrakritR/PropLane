/**
 * AXI-155 — "cannot proceed to next page in mobile application".
 *
 * Personal information (step 2) is the longest step in the apply wizard: six
 * required fields plus two ID photo slots with previews and upload/remove
 * buttons. On a phone its Back / Next row sat well below the fold, which is why
 * the report was step-specific ("i was able to go next for first few
 * application tabs") rather than a broken button.
 *
 * The standalone wizard now pins that row to the bottom of the viewport under
 * `sm`. These assertions guard the two halves that make it work: the marker
 * class reaches the standalone row, and the CSS that pins it still exists and is
 * still phone-only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WIZARD = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-application-wizard.tsx"),
  "utf8",
);
const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

const PINNED = "rental-wizard-actions--pinned";

describe("apply wizard actions are reachable on a phone", () => {
  it("marks the standalone actions row as pinned", () => {
    expect(WIZARD).toContain(PINNED);
  });

  it("pins only the standalone variant, never the embedded portal one", () => {
    // The embedded branch renders inside a modal that supplies its own footer;
    // pinning there would produce two stacked action bars.
    const actions = WIZARD.split("rental-wizard-actions");
    const embeddedBranch = actions.find((chunk) => chunk.startsWith(" mt-6 flex flex-wrap"));
    expect(embeddedBranch, "embedded actions row should still exist").toBeTruthy();
    expect(embeddedBranch).not.toContain(PINNED);
  });

  it("defines the pin as sticky, phone-only, and clear of the home indicator", () => {
    const rule = CSS.split(`.${PINNED} {`)[1]?.split("}")[0] ?? "";
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("bottom: 0");
    // Safe-area padding, or the primary button sits under the iOS home indicator.
    expect(rule).toContain("env(safe-area-inset-bottom");
    // Phone-only: at sm+ the row is a normal inline flex row again.
    const beforeRule = CSS.slice(0, CSS.indexOf(`.${PINNED} {`));
    expect(beforeRule.lastIndexOf("@media (max-width: 639px)")).toBeGreaterThan(
      beforeRule.lastIndexOf("@media (min-width"),
    );
  });

  it("uses sticky rather than fixed, so it never overlaps the last field", () => {
    const rule = CSS.split(`.${PINNED} {`)[1]?.split("}")[0] ?? "";
    expect(rule).not.toContain("position: fixed");
  });
});
