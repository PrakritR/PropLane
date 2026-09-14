// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ManagerTaskFilterFields } from "@/components/portal/pro-task-filter-fields";
import { FilterFieldsAccordion } from "@/components/portal/filter-field-lists";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <FilterFieldsAccordion>{children}</FilterFieldsAccordion>;
}

afterEach(() => cleanup());

describe("ManagerTaskFilterFields group by", () => {
  /**
   * Group by has exactly three fixed options, so it is chips rather than a
   * menu: every option is on screen and one press answers it. This used to
   * open a portaled list first — the assertion is the same ("all three are
   * offered"), it just no longer has to open anything to see them.
   */
  it("offers Property, Assignee, and Due under Group by", () => {
    render(
      <Wrapper>
        <ManagerTaskFilterFields
          listFilter="all"
          onListFilterChange={() => {}}
          tabId="in-progress"
          propertyOptions={[]}
          propertyFilterId=""
          onPropertyFilterIdChange={() => {}}
          taskGroupMode="property"
          onTaskGroupModeChange={() => {}}
          sortId="due_soonest"
          onSortIdChange={() => {}}
        />
      </Wrapper>,
    );
    expect(screen.getByText("Group by")).toBeTruthy();
    const chips = screen.getByRole("radiogroup", { name: "Group by" });
    expect(chips.textContent).toMatch(/Property/);
    expect(chips.textContent).toMatch(/Assignee/);
    expect(chips.textContent).toMatch(/Due/);
    // The current answer is readable without opening anything.
    expect(
      within(chips).getByRole("radio", { name: "Property" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("changes the grouping from one press", () => {
    const changes: string[] = [];
    render(
      <Wrapper>
        <ManagerTaskFilterFields
          listFilter="all"
          onListFilterChange={() => {}}
          tabId="in-progress"
          propertyOptions={[]}
          propertyFilterId=""
          onPropertyFilterIdChange={() => {}}
          taskGroupMode="property"
          onTaskGroupModeChange={(next) => changes.push(next)}
          sortId="due_soonest"
          onSortIdChange={() => {}}
        />
      </Wrapper>,
    );
    const chips = screen.getByRole("radiogroup", { name: "Group by" });
    fireEvent.click(within(chips).getByRole("radio", { name: "Assignee" }));
    // Outside a filter panel there is no draft to defer into, so the change
    // applies straight away — same as every other field here.
    expect(changes).toEqual(["assignee"]);
  });
});
