// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  SettingsPropertyScopeEcho,
  SettingsPropertyScopeProvider,
} from "@/components/portal/settings-property-scope";

function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

function EchoHarness({
  initialId = "",
  options,
}: {
  initialId?: string;
  options: { id: string; label: string }[];
}) {
  const [propertyId, setPropertyId] = useState(initialId);
  return (
    <SettingsPropertyScopeProvider
      propertyId={propertyId}
      onPropertyIdChange={setPropertyId}
      options={options}
    >
      <SettingsPropertyScopeEcho />
      <p data-testid="scope-id">{propertyId || "all"}</p>
    </SettingsPropertyScopeProvider>
  );
}

describe("SettingsPropertyScopeEcho — section-header property dropdown", () => {
  afterEach(() => cleanup());

  const HOUSES = [
    { id: "h1", label: "5257 Brooklyn Ave NE" },
    { id: "h2", label: "5259 Brooklyn Ave NE" },
  ];

  it("opens All properties and each house", () => {
    render(<EchoHarness options={HOUSES} />);

    const trigger = screen.getByRole("button", { name: "Property" });
    expect(trigger).toHaveTextContent("All properties");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("All properties")).toBeTruthy();
    expect(within(listbox).getByText("5257 Brooklyn Ave NE")).toBeTruthy();
    expect(within(listbox).getByText("5259 Brooklyn Ave NE")).toBeTruthy();

    tapOption(within(listbox).getByText("5259 Brooklyn Ave NE"));
    expect(screen.getByTestId("scope-id")).toHaveTextContent("h2");
    expect(screen.getByRole("button", { name: "Property" })).toHaveTextContent("5259 Brooklyn Ave NE");
  });

  it("Select all restores All properties", () => {
    render(<EchoHarness initialId="h2" options={HOUSES} />);
    fireEvent.click(screen.getByRole("button", { name: "Property" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByTestId("scope-id")).toHaveTextContent("all");
    expect(screen.getByRole("button", { name: "Property" })).toHaveTextContent("All properties");
  });

  it("still offers All properties when the workspace has no houses yet", () => {
    render(<EchoHarness options={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Property" }));
    expect(within(screen.getByRole("listbox")).getByText("All properties")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select all" })).toBeTruthy();
  });
});
