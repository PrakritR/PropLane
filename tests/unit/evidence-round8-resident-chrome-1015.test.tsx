// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the round-8 resident chrome (2026-10-15).
//
// Dumps the two phone surfaces the round reshaped, for painting by
// `tests/browser/round8-land-1015.config.ts`:
//
//   12. The native More sheet — a locked row carries the lock glyph and no chevron; an
//       `inert` lock is a no-op button with no href, an `upsell` / `notice` lock stays a
//       live link to its destination.
//   13. The compact lifecycle tracker — six steps, six columns, each label under its own
//       number, with the CURRENT step given the wider column so its full label fits.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-prefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-nav-prefetch")>()),
  portalMobileLinkPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({
  isCrossPortalNavigation: () => false,
  portalNavClick: () => () => {},
}));

const { PortalNativeMoreSheet } = await import("@/components/portal/portal-native-more-sheet");
const { ResidentLifecycleCompactTracker } = await import("@/components/portal/resident-lifecycle-compact-tracker");
const { residentLifecycleSteps } = await import("@/lib/resident-lifecycle-journey");

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; caption: string; html: string }[] = [];

function capture(name: string, caption: string) {
  captured.push({ name, caption, html: document.body.innerHTML });
}

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, caption, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html><html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="position:relative;z-index:2147483647;font:600 13px/1.5 system-ui;color:#475569;margin:12px 16px;max-width:1100px;white-space:pre-line">${caption}</p>
${html}</body></html>`,
      "utf8",
    );
  }
});

afterEach(cleanup);

describe("evidence · the resident More sheet", () => {
  it("draws an open row, an inert lock and a navigable lock", () => {
    render(
      <PortalNativeMoreSheet
        open
        onOpenChange={() => {}}
        items={[
          { section: "dashboard", label: "Dashboard", href: "/resident/dashboard" },
          { section: "payments", label: "Payments", href: "/resident/payments" },
          { section: "services", label: "Services", href: "/resident/services", locked: true },
          { section: "documents", label: "Documents", href: "/resident/documents", locked: true, lockedNavigable: true },
        ]}
        kind="resident"
        activeSection="dashboard"
        showNavIcons={false}
      />,
    );
    // An inert lock is a no-op button: no href to a path the server would just redirect home.
    const inert = screen.getByRole("button", { name: /Services \(locked\)/ });
    expect(inert.getAttribute("href")).toBeNull();
    expect(inert.querySelector(".lucide-chevron-right")).toBeNull();
    // An upsell / notice lock stays a live link to its destination.
    expect(screen.getByRole("link", { name: /Documents \(locked\)/ }).getAttribute("href")).toBe("/resident/documents");
    expect(screen.getByRole("link", { name: "Dashboard" }).querySelector(".lucide-chevron-right")).not.toBeNull();
    capture(
      "12-resident-more-sheet-locks",
      "Resident on a phone → More. An open row keeps its chevron; a locked row swaps it for the lock glyph. \"Services\" is an inert lock — a no-op button with no href, so it is never a dead click into a redirect — while \"Documents\" is a notice lock and stays a live link to the page that explains it.",
    );
  });
});

describe("evidence · the compact lifecycle tracker", () => {
  it("gives every step its own column and the current step the wider one", () => {
    const steps = residentLifecycleSteps({
      applicationSubmitted: true,
      applicationFeePaid: false,
      applicationApproved: false,
      residentSignedLease: false,
      managerCountersigned: false,
      moveInChargesPaid: false,
      movedIn: false,
    });
    const { container } = render(
      <div className="mx-4 max-w-[390px] rounded-2xl border border-border bg-card p-4">
        <ResidentLifecycleCompactTracker steps={steps} />
      </div>,
    );
    const list = container.querySelector("[data-jr-track]") as HTMLElement;
    expect(list.style.getPropertyValue("--jr-cols").split(" ")).toHaveLength(6);
    capture(
      "13-resident-compact-tracker",
      "Resident → Dashboard, at phone width. Six steps, six columns: each label sits under its own number and wraps inside that column, and the step the resident is actually on gets the wider column so its full label (\"Application received\") wraps inside its own column rather than spilling under a neighbour's number.",
    );
  });
});
