// @vitest-environment jsdom
/**
 * `usePortalListGroupSort` (`portal-list-controls.tsx`) backs every grouped
 * list, including panels rendered in plain component tests with no Next app
 * router mounted above them. Next's own `useRouter()` throws ("invariant
 * expected app router to be mounted") outside one — the hook must degrade
 * instead of taking every consumer down with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { usePortalListGroupSort } from "@/components/portal/portal-list-controls";
import type { PortalListKey } from "@/lib/portals/list-grouping";

afterEach(cleanup);

function GroupSortProbe({ listKey }: { listKey: PortalListKey }) {
  const state = usePortalListGroupSort(listKey);
  return (
    <div data-testid="probe" data-group={state.group} data-sort={state.sort}>
      <button type="button" onClick={() => state.setGroup("property")}>
        set group
      </button>
      <button type="button" onClick={() => state.setSort("amount")}>
        set sort
      </button>
    </div>
  );
}

describe("usePortalListGroupSort — no app router mounted", () => {
  it("does not throw, and resolves to the list's defaults", () => {
    expect(() => render(<GroupSortProbe listKey="payments" />)).not.toThrow();
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.group).toBe("resident");
    expect(probe.dataset.sort).toBe("due-date");
  });

  it("setGroup/setSort are safe no-ops rather than throwing without a router to navigate", () => {
    render(<GroupSortProbe listKey="payments" />);
    expect(() => screen.getByText("set group").click()).not.toThrow();
    expect(() => screen.getByText("set sort").click()).not.toThrow();
  });
});
