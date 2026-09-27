import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Night UX sweep — six screens across three portals fell back to plain,
 * unstyled "Loading…" text (or a solid, motion-less block) instead of the
 * shared shimmering `ListSkeleton` every working list (Residents, Vendors,
 * Inspections) uses. Each of these must now use the shared component.
 */
describe("bare loading text is replaced by the shared ListSkeleton", () => {
  const cases: Array<[string, string]> = [
    ["Manager Tasks", "src/components/portal/pro-task-list.tsx"],
    ["Property editor", "src/components/portal/pro-house-properties-panel.tsx"],
    ["Resident Lease", "src/components/portal/resident-lease-panel.tsx"],
    // Vendor Settings' "Business profile" group (the default landing pane at
    // /vendor/profile) is `VendorBusinessProfilePane` and its sibling panes
    // in vendor-business-settings.tsx, not vendor-settings-panel.tsx's own
    // "profile"/"capabilities" switch cases — confirmed live: the switch
    // cases render under a `group` param this route never sets by default.
    ["Vendor Settings (Business profile / Work contacts / Workspace access)", "src/components/portal/vendor-business-settings.tsx"],
    ["Vendor Settings (Availability tab, legacy switch cases)", "src/components/portal/vendor-settings-panel.tsx"],
    ["Vendor Documents", "src/components/portal/vendor-documents-panel.tsx"],
    ["Workspaces settings", "src/components/portal/workspace-settings.tsx"],
  ];

  it.each(cases)("%s imports and uses ListSkeleton", (_label, file) => {
    const src = read(file);
    expect(src).toContain('from "@/components/ui/list-skeleton"');
    expect(src).toContain("<ListSkeleton");
  });

  it("none of the six screens still render the literal bare loading strings", () => {
    expect(read("src/components/portal/pro-task-list.tsx")).not.toMatch(/<p[^>]*>Loading…<\/p>/);
    expect(read("src/components/portal/pro-house-properties-panel.tsx")).not.toMatch(
      /<p[^>]*>Loading this property…<\/p>/,
    );
    expect(read("src/components/portal/resident-lease-panel.tsx")).not.toContain("Loading your leases…");
    expect(read("src/components/portal/vendor-business-settings.tsx")).not.toMatch(/<p[^>]*>Loading[…]?<\/p>/);
    expect(read("src/components/portal/vendor-settings-panel.tsx")).not.toMatch(/<p[^>]*>Loading…<\/p>/);
    expect(read("src/components/portal/vendor-documents-panel.tsx")).not.toContain("Loading documents…");
    expect(read("src/components/portal/workspace-settings.tsx")).not.toContain("Loading workspaces…");
  });
});

/**
 * A third, solid-dark-grey-block variant (no shimmer/motion cue) shipped
 * alongside the text variant, on Communication's header identity cards and
 * all of vendor Invoices — reading as broken rather than loading.
 */
describe("solid loading blocks match the shared shimmer tone", () => {
  it("manager work-number/work-email identity cards use the shared accent shimmer, not a flat bg-muted block", () => {
    const src = read("src/components/portal/pro-work-number-card.tsx");
    expect(src).toContain("bg-accent/50");
    expect(src).not.toMatch(/h-\[52px\] animate-pulse rounded-2xl bg-muted/);
  });

  it("vendor Invoices loading uses the shared ListSkeleton instead of one flat block", () => {
    const src = read("src/components/portal/vendor-finances-panel.tsx");
    expect(src).toContain('from "@/components/ui/list-skeleton"');
    expect(src).toContain("<ListSkeleton");
    expect(src).not.toMatch(/h-40 animate-pulse rounded-2xl bg-muted/);
  });
});

/**
 * Vendor Settings' Availability Save buttons were enabled before the
 * initial `fetchVendorAvailability()` load completed — a vendor could tap
 * Save before any field had actually populated. The Business profile Save
 * was already correctly gated (`profileSaving || profileLoading`); the
 * Availability tab's three Save buttons only checked `saving`, never
 * `loaded`.
 */
describe("vendor Availability Save waits for the initial load", () => {
  it("all three Save buttons are disabled until `loaded` is true, in addition to `saving`", () => {
    const src = read("src/components/portal/vendor-settings-panel.tsx");
    const occurrences = (src.match(/disabled=\{saving \|\| !loaded\}/g) ?? []).length;
    expect(occurrences).toBe(3);
    expect(src).not.toMatch(/disabled=\{saving\}(?!\s*\|\|)/);
  });
});
