// @vitest-environment jsdom
//
// PLAN B1 — switching the manager's Active/Archived tab must be instant, with
// no App Router navigation (which remounted ManagerUnifiedInbox and re-ran
// every source fetch). `InboxListSegmentTabs` preventDefaults a plain left
// click only when `interceptNavigation` is set; resident/vendor callers omit
// it and keep ordinary <Link> navigation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { InboxListSegmentTabs } from "@/components/portal/portal-inbox-ui";
import { useCommunicationListSegment } from "@/hooks/use-communication-list-segment";

afterEach(cleanup);

describe("InboxListSegmentTabs interceptNavigation", () => {
  it("preventDefaults a plain left click and calls onChange, when interceptNavigation is set", () => {
    const onChange = vi.fn();
    render(
      <InboxListSegmentTabs
        commBase="/portal/communication"
        value="active"
        onChange={onChange}
        interceptNavigation
      />,
    );
    const link = screen.getByRole("link", { name: /^Archived/ });
    const event = fireEvent.click(link, { button: 0 });
    // jsdom's fireEvent.click returns false when preventDefault was called.
    expect(event).toBe(false);
    expect(onChange).toHaveBeenCalledWith("archived");
  });

  it("does not preventDefault a modifier-key click (open in new tab)", () => {
    const onChange = vi.fn();
    render(
      <InboxListSegmentTabs
        commBase="/portal/communication"
        value="active"
        onChange={onChange}
        interceptNavigation
      />,
    );
    const link = screen.getByRole("link", { name: /^Archived/ });
    const event = fireEvent.click(link, { button: 0, metaKey: true });
    expect(event).toBe(true);
    expect(onChange).toHaveBeenCalledWith("archived");
  });

  it("keeps ordinary navigation when interceptNavigation is omitted (resident/vendor)", () => {
    const onChange = vi.fn();
    render(<InboxListSegmentTabs commBase="/portal/communication" value="active" onChange={onChange} />);
    const link = screen.getByRole("link", { name: /^Archived/ });
    const event = fireEvent.click(link, { button: 0 });
    expect(event).toBe(true);
    expect(onChange).toHaveBeenCalledWith("archived");
  });
});

describe("useCommunicationListSegment", () => {
  it("initializes from the routed prop and updates on setSegment", () => {
    const { result } = renderHook(() => useCommunicationListSegment("/portal/communication", "active"));
    expect(result.current.segment).toBe("active");
    act(() => result.current.setSegment("archived"));
    expect(result.current.segment).toBe("archived");
  });

  it("follows the URL on browser back/forward (popstate)", () => {
    const { result } = renderHook(() => useCommunicationListSegment("/portal/communication", "active"));
    act(() => result.current.setSegment("archived"));
    expect(result.current.segment).toBe("archived");

    window.history.pushState(null, "", "/portal/communication/active");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(result.current.segment).toBe("active");
  });

  it("re-syncs from a genuinely new routed prop (a real remount)", () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial: "active" | "unread" | "archived" }) =>
        useCommunicationListSegment("/portal/communication", initial),
      { initialProps: { initial: "active" as const } },
    );
    act(() => result.current.setSegment("archived"));
    rerender({ initial: "unread" });
    expect(result.current.segment).toBe("unread");
  });
});
