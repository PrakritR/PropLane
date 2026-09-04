// @vitest-environment jsdom

/**
 * AXI-162 — "inside house details I can scroll all the way down for some reason.
 * a lot of scrolling is broken in all of these tabs."
 *
 * `data-portal-sticky-chrome` is ONE document flag with SEVERAL owners:
 * `ManagerPortalPageShell` on list pages, `PortalRecordDetailPage` on detail
 * pages. A route change mounts the new owner while the old one is unmounting, so
 * with a plain set/delete the outgoing cleanup ran last and deleted the flag the
 * incoming page had just set.
 *
 * Without the flag `#portal-main-content` is not clipped to a flex viewport, so
 * the page's `flex-1 … overflow-y-auto` scroll body resolves `flex-1` against
 * nothing, grows to full content height, and the surface ends up with two nested
 * scrollers and dead space below the content — visible only after NAVIGATING,
 * never on a fresh load.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  usePortalStickyPageChrome,
  __resetPortalStickyPageChromeForTests,
} from "@/hooks/use-portal-sticky-page-chrome";

function Surface({ active = true }: { active?: boolean }) {
  usePortalStickyPageChrome(active);
  return null;
}

const flag = () => document.documentElement.dataset.portalStickyChrome;

describe("sticky page chrome ownership", () => {
  beforeEach(() => __resetPortalStickyPageChromeForTests());
  afterEach(() => {
    cleanup();
    __resetPortalStickyPageChromeForTests();
  });

  it("sets the flag while a surface wants it", () => {
    render(<Surface />);
    expect(flag()).toBe("true");
  });

  it("keeps it while ANOTHER surface still wants it", () => {
    // The route-change shape: both are mounted for a moment.
    const list = render(<Surface />);
    const detail = render(<Surface />);
    expect(flag()).toBe("true");

    list.unmount(); // the outgoing page cleans up last
    expect(flag()).toBe("true");

    detail.unmount();
    expect(flag()).toBeUndefined();
  });

  it("removes it once the last owner is gone", () => {
    const one = render(<Surface />);
    one.unmount();
    expect(flag()).toBeUndefined();
  });

  it("an inactive surface never claims it", () => {
    render(<Surface active={false} />);
    expect(flag()).toBeUndefined();
  });

  it("does not go negative when an inactive surface unmounts alongside an active one", () => {
    const active = render(<Surface />);
    const inactive = render(<Surface active={false} />);
    inactive.unmount();
    expect(flag()).toBe("true");
    active.unmount();
    expect(flag()).toBeUndefined();
  });
});
