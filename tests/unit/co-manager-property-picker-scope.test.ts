/**
 * AXI-156 — "Co-manager cannot view portfolio properties".
 *
 * A co-manager's linked listings are stored under the OWNER's id in the property
 * pipeline, never the viewer's. So any picker built from
 * `readExtraListingsForUser(managerUserId)` alone lists only what the viewer
 * owns, and a co-manager sees "No properties in portfolio" — while the
 * Properties tab, which reads the server snapshot, shows the same homes fine.
 * That mismatch is exactly what was reported on the Add application modal.
 *
 * `manager-add-lease-modal` already had the correct third loop over
 * `collectLinkedPropertyIdsForModule`. This scan stops a NEW picker from
 * shipping without it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = path.join(process.cwd(), "src/components/portal");

/**
 * Files that read the viewer-owned store for a reason OTHER than building a
 * property picker. Each entry needs a reason — this is not a place to silence a
 * genuine finding.
 */
const NOT_A_PICKER: Record<string, string> = {
  "pro-house-properties-panel.tsx":
    "Reads readExtraListingsForUser(linkedOwnerId) — the OWNER's store, deliberately, to edit a linked listing.",
};

function readPortalFile(name: string): string {
  return readFileSync(path.join(PORTAL_DIR, name), "utf8");
}

function portalFilesReadingOwnedListings(): string[] {
  return readdirSync(PORTAL_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => readPortalFile(name).includes("readExtraListingsForUser"));
}

describe("co-manager property pickers include linked listings", () => {
  it("finds the surfaces this rule governs", () => {
    // A guard that silently matches nothing is worse than no guard.
    expect(portalFilesReadingOwnedListings().length).toBeGreaterThan(5);
  });

  it("every property picker also reads linked (co-managed) listings", () => {
    const offenders: string[] = [];
    for (const name of portalFilesReadingOwnedListings()) {
      if (NOT_A_PICKER[name]) continue;
      const source = readPortalFile(name);
      const linkedAware =
        source.includes("collectLinkedPropertyIdsForModule") ||
        source.includes("readLinkedListingsForUser") ||
        source.includes("collectLinkedPropertyIds(");
      if (!linkedAware) offenders.push(name);
    }
    expect(
      offenders,
      `These build a property list from the viewer's own store only, so a co-manager sees an empty picker. Add the linked loop (see manager-add-lease-modal.tsx), or document the file in NOT_A_PICKER with a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the allowlist honest — every entry must still exist and still opt out", () => {
    for (const [name, reason] of Object.entries(NOT_A_PICKER)) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(20);
      expect(() => readPortalFile(name), `${name} no longer exists — drop it`).not.toThrow();
    }
  });
});
