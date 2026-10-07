// @vitest-environment jsdom
/**
 * Residents get the PropLane assistant on their own role-scoped endpoint (captain, Oct 7). The
 * desktop header renders the "Ask PropLane" pill and binds Cmd/Ctrl+K for a resident exactly as it
 * does for the manager, and the resident layout mounts the provider on the resident endpoint only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { getAxisAssistantOpen, closeAxisAssistant } from "@/lib/axis-assistant/open-store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/dashboard",
}));
vi.mock("@/components/portal/portal-role-switcher", () => ({ PortalRoleSwitcher: () => null }));
vi.mock("@/components/portal/portal-sign-out-button", () => ({ PortalSignOutButton: () => null }));

afterEach(() => {
  closeAxisAssistant();
  cleanup();
});

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("PortalTopBar assistant launcher", () => {
  it("renders the Ask PropLane launcher for a resident and opens on Cmd+K", () => {
    render(<PortalTopBar kind="resident" basePath="/resident" name="Test Resident" email="r@example.com" />);
    expect(screen.getByText("Ask PropLane")).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-ask-proplane"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(getAxisAssistantOpen()).toBe(true);
  });

  it("keeps the launcher for the manager portal", () => {
    render(<PortalTopBar kind="manager" basePath="/portal" name="Test Manager" email="m@example.com" />);
    expect(screen.getByText("Ask PropLane")).toBeTruthy();
  });

  it("the launcher is mounted for every portal kind with no per-kind branch", () => {
    expect(read("src/components/portal/portal-top-bar.tsx")).not.toMatch(/kind === "resident" \? null/);
  });
});

describe("resident assistant mount", () => {
  it("targets the resident endpoint and never the manager endpoint", () => {
    const layout = read("src/app/resident/layout.tsx");
    expect(layout).toContain("<AxisAssistant");
    expect(layout).toContain('endpoint="/api/agent/resident-chat"');
    expect(layout).not.toContain("/api/agent/chat");
    expect(layout).not.toContain("/api/agent/vendor-chat");
    // An <AxisAssistant> with no endpoint falls back to the manager route and 401s for a resident.
    for (const tag of layout.match(/<AxisAssistant[^>]*>/g) ?? []) expect(tag).toContain("endpoint=");
  });
});
