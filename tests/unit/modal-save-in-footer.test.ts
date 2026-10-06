import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A pop-up's primary action sits in the shell's footer slot (bottom-right),
 * never inline under the fields. These pop-ups used to render a ModalFooter
 * as a child of <Modal>; `footer={<ModalFooter …>}` is the one placement.
 */
const FILES = [
  "workspace-invite-link-strip",
  "house-printables-card",
  "account-processing-fee-settings",
  "pro-plan-adjust-sheet",
  "messaging-credit-panel",
  "pro-vendors-panel",
  "manager-plan-addons-panel",
];

describe("pop-up primary action lives in the Modal footer slot", () => {
  for (const name of FILES) {
    it(`${name}: no ModalFooter inside the Modal body`, () => {
      const src = readFileSync(`src/components/portal/${name}.tsx`, "utf8");
      // Every <ModalFooter must be preceded (same JSX expression) by `footer=`.
      for (const m of src.matchAll(/<ModalFooter/g)) {
        const before = src.slice(Math.max(0, (m.index ?? 0) - 120), m.index);
        expect(before, `${name} has an inline ModalFooter`).toMatch(/footer=\{[^<]*$/);
      }
    });
  }

  it("Edit permissions (Team strip) Save is the primary action", () => {
    const src = readFileSync("src/components/portal/workspace-invite-link-strip.tsx", "utf8");
    const attr = src.indexOf('data-attr="workspace-invite-link-edit-save"');
    expect(attr, "Save button not found").toBeGreaterThan(-1);
    const save = src.slice(src.lastIndexOf("<Button", attr), src.indexOf(">", attr));
    expect(save).toContain('variant="primary"');
  });
});
