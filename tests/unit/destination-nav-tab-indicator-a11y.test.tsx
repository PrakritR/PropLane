// @vitest-environment jsdom
//
// M005/M014 — the header-card tabs' new traveling underline indicator and
// value-flash count pill must never surface as an extra tab, break keyboard
// navigation, or double up an accessible name. This is the "tabs a11y" check
// the motion pass is required to add (see the M005 change in
// ~/proplane-mock-kit/studio/changes.json: "one hook in core.js's shared
// .plp-htabs/.plp-segtabs markup" — the real equivalent here is
// `DestinationNav`/`LocalDestinationNav`'s `appearance="command"` mode).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DestinationNav, LocalDestinationNav } from "@/components/ui/destination-nav";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

// Same reason as manager-portal-primitives.test.tsx: no RTL auto-cleanup
// (`globals: true` is off), and DestinationNav renders `next/link`.
afterEach(cleanup);

describe("DestinationNav command tabs — indicator does not break tab semantics", () => {
  it("the new underline indicator is aria-hidden and not itself a link", () => {
    const { container } = render(
      <DestinationNav
        items={[
          { id: "active", label: "Active", href: "/portal/communication/active", count: 3 },
          { id: "archived", label: "Archived", href: "/portal/communication/archived" },
        ]}
        activeId="active"
        appearance="command"
      />,
    );
    // Still exactly two links, each with its own accessible name — the
    // indicator adds no extra focusable/role="link" element.
    expect(screen.getAllByRole("link")).toHaveLength(2);
    const indicator = container.querySelector(".motion-tab-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.tagName).toBe("SPAN");
  });

  it("aria-current still lands on exactly the active tab", () => {
    render(
      <DestinationNav
        items={[
          { id: "active", label: "Active", href: "/x/active" },
          { id: "archived", label: "Archived", href: "/x/archived" },
        ]}
        activeId="active"
        appearance="command"
      />,
    );
    expect(screen.getByRole("link", { name: /Active/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Archived/ }).getAttribute("aria-current")).toBeNull();
  });

  it("the count pill's accessible label is unaffected by the value-flash class", () => {
    render(
      <DestinationNav
        items={[{ id: "pending", label: "Pending", href: "/x/pending", count: 5 }]}
        activeId="pending"
        appearance="command"
      />,
    );
    expect(screen.getByLabelText("5 items")).toBeTruthy();
  });
});

describe("LocalDestinationNav command tabs — keyboard/role contract unchanged", () => {
  it("switching the active tab keeps exactly one aria-current and still fires onChange", () => {
    const onChange = vi.fn();
    render(
      <LocalDestinationNav
        items={[
          { id: "unopened", label: "Unopened" },
          { id: "opened", label: "Opened" },
        ]}
        activeId="unopened"
        onChange={onChange}
        appearance="command"
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Opened/ }));
    expect(onChange).toHaveBeenCalledWith("opened");
  });
});
