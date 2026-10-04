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

  it("treats only the resident portal subtree as assistant-free", () => {
    expect(isAssistantFreePath(RESIDENT_PORTAL_BASE_PATH)).toBe(true);
    expect(isAssistantFreePath("/resident/communication")).toBe(true);
    expect(isAssistantFreePath("/residents-guide")).toBe(false);
    expect(isAssistantFreePath("/portal/communication")).toBe(false);
    expect(isAssistantFreePath(null)).toBe(false);
  });
});
