// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerTaskFilterFields } from "@/components/portal/pro-task-filter-fields";
import { FilterFieldsAccordion } from "@/components/portal/filter-field-lists";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <FilterFieldsAccordion>{children}</FilterFieldsAccordion>;
}

afterEach(() => cleanup());

describe("ManagerTaskFilterFields group by", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Group by: Property" }));
    const list = document.querySelector('[data-attr="tasks-filter-group-mode"]');
    expect(list).toBeTruthy();
    expect(list?.textContent).toMatch(/Property/);
    expect(list?.textContent).toMatch(/Assignee/);
    expect(list?.textContent).toMatch(/Due/);
  });
});
