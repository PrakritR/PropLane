// @vitest-environment jsdom
/**
 * Residents have no PropLane assistant. The desktop header must not render the "Ask PropLane" pill,
 * and its Cmd/Ctrl+K shortcut must not be bound; the manager header keeps both.
 */
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

describe("PortalTopBar assistant launcher", () => {
  it("renders no Ask PropLane launcher for a resident and ignores Cmd+K", () => {
    render(<PortalTopBar kind="resident" basePath="/resident" name="Test Resident" email="r@example.com" />);
    expect(screen.queryByText("Ask PropLane")).toBeNull();
    expect(document.querySelector('[data-attr="portal-ask-proplane"]')).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(getAxisAssistantOpen()).toBe(false);
  });

  it("keeps the launcher for the manager portal", () => {
    render(<PortalTopBar kind="manager" basePath="/portal" name="Test Manager" email="m@example.com" />);
    expect(screen.getByText("Ask PropLane")).toBeTruthy();
  });
});
