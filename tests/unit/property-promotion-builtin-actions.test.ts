import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("property promotion builtins (C2-TAB3)", () => {
  it("wires Download and Share on default promotion rows", () => {
    const panel = readFileSync(
      resolve(process.cwd(), "src/components/portal/pro-property-promotion-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain("onDownload={() => downloadBuiltin(def.key)}");
    expect(panel).toContain("onShare={() => void shareBuiltin(def.key)}");
    expect(panel).toContain("downloadBuiltin");
    expect(panel).toContain("shareBuiltin");
    expect(panel).toContain("resolveBuiltinFlyerPromotion");
    const modal = readFileSync(
      resolve(process.cwd(), "src/components/portal/property-promotion-builtin-modal.tsx"),
      "utf8",
    );
    expect(modal).toContain("PromotionFlyerPreview");
    expect(modal).toContain("PromotionPostPreview");
  });

  it("the Door card row is the one entry point: it opens the print sheet", () => {
    const panel = readFileSync(
      resolve(process.cwd(), "src/components/portal/pro-property-promotion-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('def.kind === "print" ? downloadBuiltin(def.key) : openBuiltinEditor(def.key)');
    expect(panel).toContain("/print/door-card/");
    const house = readFileSync(
      resolve(process.cwd(), "src/components/portal/property-house-details-list-panel.tsx"),
      "utf8",
    );
    expect(house).not.toContain('"Door card"');
    expect(house).not.toContain('"door"');
  });
});
