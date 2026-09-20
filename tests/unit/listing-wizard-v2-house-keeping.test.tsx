// @vitest-environment jsdom
//
// The "Move-in · The building · Local compliance" disclosure at the foot of
// Basics opens — it used to be rendered shut with a no-op toggle, so Local
// compliance could never be reached from the editor.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

describe("Basics · Move-in · The building · Local compliance", () => {
  it("opens on click, lists the three groups, and Local compliance shows its fields and writes them", () => {
    const onChange = vi.fn();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2 title="New listing" submission={createDefaultListingSubmission()} onChange={onChange} onClose={() => {}} onPublish={() => {}} />
      </PortalAssistantConfigProvider>,
    );
    const bar = document.querySelector<HTMLButtonElement>("[data-attr='listing-v2-house-keeping']")!;
    expect(bar.textContent).toContain("Advanced");
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-attr='listing-v2-house-compliance']")).toBeNull();

    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-attr='listing-v2-house-movein']")).not.toBeNull();
    expect(document.querySelector("[data-attr='listing-v2-house-building']")).not.toBeNull();
    const compliance = document.querySelector<HTMLButtonElement>("[data-attr='listing-v2-house-compliance']")!;
    expect(compliance.textContent).toContain("Local compliance");

    fireEvent.click(compliance);
    expect(screen.getByText("Certificate of occupancy date")).toBeInTheDocument();
    const rrioLabel = screen.getByText("RRIO registration number");
    const rrioInput = rrioLabel.closest("label, div")!.parentElement!.querySelector("input") ?? rrioLabel.parentElement!.querySelector("input");
    expect(rrioInput).not.toBeNull();
    fireEvent.change(rrioInput!, { target: { value: "RRIO-2024-018832" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rrioRegistrationNumber: "RRIO-2024-018832" }));

    // Closes again on a second click.
    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("false");
  });
});
