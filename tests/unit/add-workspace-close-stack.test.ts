import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nextOnPathIndex, prevOnPathIndex } from "@/components/portal/add-workspace/path";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
const modalStylesSource = readFileSync(resolve(process.cwd(), "src/components/ui/modal-styles.ts"), "utf8");
const overlaySource = readFileSync(
  resolve(process.cwd(), "src/components/portal/listing-wizard-v2/wizard-overlay.tsx"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve(process.cwd(), "src/components/portal/add-workspace/index.tsx"),
  "utf8",
);

function highestArbitraryZ(source: string): number {
  const found = [...source.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}

describe("add-workspace close stack", () => {
  it("raises confirm / modal above the listing-wizard overlay and below field-select menus", () => {
    const overlayZ = [...overlaySource.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(overlayZ).toContain(80);

    const modalZ = Math.max(highestArbitraryZ(modalSource), highestArbitraryZ(modalStylesSource));
    expect(modalZ).toBeGreaterThan(80);
    expect(modalZ).toBeLessThan(10060);
  });

  it("empty close skips confirm; Esc uses the same close path", () => {
    expect(workspaceSource).toMatch(/if \(!dirty\) \{\s*onClose\(\);/);
    expect(workspaceSource).toMatch(/event\.key !== "Escape"/);
    expect(workspaceSource).toContain("close()");
  });

  it("things-to-finish card still jumps to the last rail step", () => {
    expect(workspaceSource).toMatch(/const last = steps\.length - 1/);
    expect(workspaceSource).toContain("onJump(last)");
  });

  it("Continue skips off-path extras", () => {
    const steps = [
      { id: "contact" },
      { id: "home" },
      { id: "application", offPath: true },
      { id: "lease" },
      { id: "payments", offPath: true },
      { id: "documents", offPath: true },
      { id: "review" },
    ];
    expect(nextOnPathIndex(steps, 0)).toBe(1);
    expect(nextOnPathIndex(steps, 1)).toBe(3);
    expect(nextOnPathIndex(steps, 3)).toBe(6);
    expect(nextOnPathIndex(steps, 6)).toBeNull();
    expect(prevOnPathIndex(steps, 3)).toBe(1);
    expect(prevOnPathIndex(steps, 1)).toBe(0);
    expect(prevOnPathIndex(steps, 0)).toBeNull();
  });
});
