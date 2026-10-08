// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GeneralAssistantFab, isAssistantFreePath } from "@/components/general/general-assistant";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";

const pathnameMock = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.value }));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: false, platform: null }) }));

beforeEach(() => {
  pathnameMock.value = null;
});
afterEach(cleanup);

describe("GeneralAssistantFab", () => {
  it("renders a bottom-right chat trigger on public pages", () => {
    render(<GeneralAssistantFab />);
    expect(screen.getByRole("button", { name: "Ask PropLane" })).toHaveAttribute(
      "data-attr",
      "general-assistant-fab",
    );
  });

  it("still renders on a non-marketing public path", () => {
    pathnameMock.value = "/auth/sign-in";
    render(<GeneralAssistantFab />);
    expect(screen.getByRole("button", { name: "Ask PropLane" })).toBeInTheDocument();
  });

  it.each(["/resident", "/resident/communication", "/resident/payments/abc"])(
    "renders nothing on the resident portal path %s",
    (path) => {
      pathnameMock.value = path;
      const { container } = render(<GeneralAssistantFab />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("button", { name: "Ask PropLane" })).toBeNull();
    },
  );

  it.each([
    "/portal",
    "/portal/calendar",
    "/portal/settings",
    "/portal/properties/abc",
    "/vendor",
    "/vendor/services",
    "/vendor/settings",
    "/admin",
    "/admin/inbox",
  ])("renders nothing inside the authenticated portal path %s", (path) => {
    pathnameMock.value = path;
    const { container } = render(<GeneralAssistantFab />);
    expect(container).toBeEmptyDOMElement();
  });

  it("treats every authenticated portal subtree as assistant-free, not lookalike public paths", () => {
    expect(isAssistantFreePath("/portal/communication")).toBe(true);
    expect(isAssistantFreePath("/vendor/settings")).toBe(true);
    expect(isAssistantFreePath("/admin/inbox")).toBe(true);
    expect(isAssistantFreePath("/vendors")).toBe(false);
    expect(isAssistantFreePath("/portals")).toBe(false);
    expect(isAssistantFreePath("/administrators")).toBe(false);
  });

  it("treats the resident and owner portal subtrees as assistant-free", () => {
    expect(isAssistantFreePath(RESIDENT_PORTAL_BASE_PATH)).toBe(true);
    expect(isAssistantFreePath("/resident/communication")).toBe(true);
    expect(isAssistantFreePath("/portal/owner")).toBe(true);
    expect(isAssistantFreePath("/portal/owner/statements")).toBe(true);
    expect(isAssistantFreePath("/residents-guide")).toBe(false);
    expect(isAssistantFreePath(null)).toBe(false);
  });
});
