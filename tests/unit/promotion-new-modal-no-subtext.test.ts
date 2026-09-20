import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src/components/portal/promotion-new-modal.tsx");

describe("PromotionNewModal has no helper sentences under Kind", () => {
  it("does not render selected.description under the type picker", () => {
    const src = readFileSync(SRC, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/selected\.description/);
    expect(src).not.toMatch(/opt\.description|selected\.description/);
  });
});
