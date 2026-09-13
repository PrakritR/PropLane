// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/portal/assistant-dock-panel", () => ({
  AssistantDockPanel: () => <div data-testid="assistant-panel">Assistant</div>,
}));

import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

describe("listing wizard Ask PropLane", () => {
  it("opens the assistant rail inside the overlay dialog", () => {
    const sub = createDefaultListingSubmission();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingWizardOverlay>
          <ListingEditorV2
            title="Test listing"
            submission={sub}
            onChange={() => {}}
            onClose={() => {}}
            onSaveExit={() => {}}
            onPublish={() => {}}
            isEdit={false}
          />
        </ListingWizardOverlay>
      </PortalAssistantConfigProvider>,
    );

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ask PropLane/i }));
    expect(dialog).toHaveAttribute("data-modal-assistant-open");
    expect(screen.getByRole("complementary", { name: "PropLane Assistant" })).toBeTruthy();
    expect(dialog).toContainElement(screen.getByRole("complementary", { name: "PropLane Assistant" }));
  });
});
