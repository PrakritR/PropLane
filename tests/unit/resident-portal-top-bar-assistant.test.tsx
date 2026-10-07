// @vitest-environment jsdom
/**
 * Residents get the PropLane assistant on their own role-scoped endpoint (captain, Oct 7). The
 * desktop top strip renders the "Ask PropLane or search" bar and binds Cmd/Ctrl+K for a resident
 * exactly as it does for the manager, the palette's Ask row opens the assistant, and the resident
 * layout mounts the provider on the resident endpoint only.
 *
 * Phase 1 shell redesign: Cmd/Ctrl+K now opens the command palette (its first row, Ask PropLane,
 * opens the assistant) instead of toggling the assistant directly; the strip's right-hand panel
 * button is the direct assistant toggle.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { getAxisAssistantOpen, closeAxisAssistant } from "@/lib/axis-assistant/open-store";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import { proPortal } from "@/lib/portals/pro";
import type { PortalDefinition } from "@/lib/portal-types";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/dashboard",
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u1", email: "r@example.com", ready: true }),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useNativeChrome: () => false,
  useIsSmallPortalViewport: () => false,
}));

afterEach(() => {
  closeAxisAssistant();
  cleanup();
  pushMock.mockClear();
});

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const residentDefinition: PortalDefinition = {
  kind: "resident",
  basePath: "/resident",
  title: "PropLane",
  accent: "blue",
  sections: RESIDENT_UNIFIED_PORTAL_SECTIONS,
};

function renderStrip(kind: "resident" | "manager" | "vendor") {
  const definition = kind === "resident" ? residentDefinition : kind === "vendor" ? vendorPortal : proPortal;
  return render(
    <PortalTopBar
      kind={kind}
      basePath={definition.basePath}
      definition={definition}
      subscriptionTier="paid"
      name="Test User"
      email="u@example.com"
    />,
  );
}

describe("PortalTopBar launcher", () => {
  it("renders the Ask PropLane or search bar for a resident and opens the palette on Cmd+K", () => {
    renderStrip("resident");
    expect(screen.getByText(/Ask PropLane or search Resident portal/)).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-ask-proplane"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.querySelector('[data-attr="portal-command-palette"]')).not.toBeNull();
  });

  it("the palette's Ask row opens the assistant for a resident", () => {
    renderStrip("resident");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(getAxisAssistantOpen()).toBe(false);
    fireEvent.click(document.querySelector('[data-attr="portal-palette-ask"]')!);
    expect(getAxisAssistantOpen()).toBe(true);
  });

  it("the right-hand panel button opens the assistant for a vendor", () => {
    renderStrip("vendor");
    fireEvent.click(screen.getByRole("button", { name: "Open PropLane Assistant" }));
    expect(getAxisAssistantOpen()).toBe(true);
  });

  it("keeps the launcher for the manager portal", () => {
    renderStrip("manager");
    expect(screen.getByText(/Ask PropLane or search/)).toBeTruthy();
  });

  it("the launcher is mounted for every portal kind with no per-kind branch", () => {
    expect(read("src/components/portal/portal-top-bar.tsx")).not.toMatch(/kind === "resident" \? null/);
  });
});

describe("assistant mounts", () => {
  it("resident targets the resident endpoint and never the manager endpoint", () => {
    const layout = read("src/app/resident/layout.tsx");
    expect(layout).toContain("<AxisAssistant");
    expect(layout).toContain('endpoint="/api/agent/resident-chat"');
    expect(layout).not.toContain("/api/agent/chat");
    expect(layout).not.toContain("/api/agent/vendor-chat");
    // An <AxisAssistant> with no endpoint falls back to the manager route and 401s for a resident.
    for (const tag of layout.match(/<AxisAssistant[^>]*>/g) ?? []) expect(tag).toContain("endpoint=");
  });

  it("each portal layout mounts the strip and the rail INSIDE its own role-scoped assistant provider", () => {
    // The strip's launcher and the palette's Ask row reach whichever assistant surrounds them, so a
    // layout that mounted them outside its provider would open the wrong role's endpoint (or none).
    for (const [file, endpoint] of [
      ["src/app/portal/layout.tsx", null],
      ["src/app/resident/layout.tsx", "/api/agent/resident-chat"],
      ["src/app/vendor/layout.tsx", "/api/agent/vendor-chat"],
    ] as const) {
      const layout = read(file);
      const open = layout.indexOf("<AxisAssistant");
      const close = layout.lastIndexOf("</AxisAssistant>");
      expect(open, file).toBeGreaterThan(-1);
      expect(layout.indexOf("<PortalTopBar"), file).toBeGreaterThan(open);
      expect(layout.indexOf("<PortalTopBar"), file).toBeLessThan(close);
      expect(layout.indexOf("<PortalWorkspaceRail"), file).toBeGreaterThan(open);
      expect(layout.indexOf("<PortalWorkspaceRail"), file).toBeLessThan(close);
      if (endpoint) expect(layout).toContain(`endpoint="${endpoint}"`);
    }
  });
});
