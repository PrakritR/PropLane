// @vitest-environment jsdom
//
// The one pop-up shape (PLAN-0920-1058 "1d · The pop-up",
// docs/agents/ui-change-checklist.md § Pop-ups): every portal dialog is a
// PortalDialog, its footer is exactly one text secondary + one filled
// primary, its header carries no muted explainer sentence, and the
// in-workspace "Ask PropLane" chip — top-bar chrome, not dialog chrome —
// never renders inside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

const ROOT = join(__dirname, "..", "..");

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

/** Desktop dialog, not the phone drawer, so the assertions walk a stable DOM shape. */
function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("PortalDialog footer shape", () => {
  it("renders exactly one filled primary and one text secondary", () => {
    mockDesktopMatchMedia();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        title="Record payment"
        primaryAction={{ label: "Record $1,200", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const buttons = Array.from(dialog.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-label") !== "Close",
    );
    // Exactly the secondary (default "Cancel") and the primary — never two commit buttons.
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Record $1,200"]);
    const primary = screen.getByText("Record $1,200").closest("button")!;
    const secondary = screen.getByText("Cancel").closest("button")!;
    expect(primary.className).toContain("text-white");
    expect(secondary.className).not.toContain("text-white");
  });

  it("never renders two filled buttons — a caller cannot add a second primary", () => {
    mockDesktopMatchMedia();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        title="Delete charge"
        tone="danger"
        primaryAction={{ label: "Delete charge", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const filled = Array.from(dialog.querySelectorAll("button")).filter((b) =>
      b.className.includes("text-white"),
    );
    expect(filled).toHaveLength(1);
    expect(filled[0].className).toContain("!bg-danger");
  });

  it("can omit the secondary without leaving two primaries in its place", () => {
    mockDesktopMatchMedia();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        title="Step"
        secondaryAction={null}
        primaryAction={{ label: "Continue", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const buttons = Array.from(dialog.querySelectorAll("button")).filter(
      (b) => b.getAttribute("aria-label") !== "Close",
    );
    expect(buttons.map((b) => b.textContent)).toEqual(["Continue"]);
  });
});

describe("PortalDialog header", () => {
  it("carries no muted explainer sentence under the title", () => {
    mockDesktopMatchMedia();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        title="Send reminder"
        primaryAction={{ label: "Send reminder", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    expect(document.getElementById("modal-description")).toBeNull();
  });

  it("shows a step-dot strip, never a sentence, for a wizard step", () => {
    mockDesktopMatchMedia();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        title="Add booking"
        size="wizard"
        step={{ current: 2, total: 3 }}
        primaryAction={{ label: "Continue", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    const strip = screen.getByRole("progressbar", { name: "Step 2 of 3" });
    expect(strip).toBeTruthy();
    expect(strip.textContent?.trim()).toBe("");
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-[720px]");
  });

  it("shows a back arrow only when a step supplies one", () => {
    mockDesktopMatchMedia();
    const onBack = vi.fn();
    render(
      <PortalDialog
        open
        onClose={() => {}}
        onBack={onBack}
        title="Guest details"
        primaryAction={{ label: "Continue", onClick: () => {} }}
      >
        <p>Body</p>
      </PortalDialog>,
    );
    screen.getByLabelText("Back").click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("never shows the 'Ask PropLane' chip — that lives in the top bar only", () => {
    mockDesktopMatchMedia();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName="Test Manager">
        <PortalDialog
          open
          onClose={() => {}}
          title="Assign vendor"
          primaryAction={{ label: "Assign vendor", onClick: () => {} }}
        >
          <p>Body</p>
        </PortalDialog>
      </PortalAssistantConfigProvider>,
    );
    expect(screen.queryByText("Ask PropLane")).toBeNull();
  });
});

describe("PortalDialog adoption — source guard", () => {
  const adopted: Array<{ file: string; marker?: string }> = [
    { file: "src/components/portal/confirm-delete-modal.tsx" },
    { file: "src/components/portal/portal-delete-account-button.tsx" },
    { file: "src/components/portal/portal-notification-preview-modal.tsx" },
    {
      file: "src/components/portal/portal-notification-preview-modal.tsx",
      marker: "export function PortalBulkPaymentReminderPreviewModal(",
    },
    { file: "src/components/portal/pro-properties.tsx" },
    { file: "src/components/portal/schedule-service-visit-modal.tsx" },
    { file: "src/components/portal/pro-work-orders-panel.tsx" },
    { file: "src/components/portal/pro-create-service-request-modal.tsx" },
    { file: "src/components/portal/inspection-editor.tsx" },
    { file: "src/components/portal/bookings-block-dates-modal.tsx" },
    { file: "src/components/portal/pro-communication-compose-modal.tsx" },
    { file: "src/components/portal/share-lead-link-modal.tsx" },
    { file: "src/components/portal/manager-invite-link-modal.tsx" },
    { file: "src/components/portal/vendor-finances-panel.tsx" },
    { file: "src/components/portal/resident-payments-panel.tsx" },
    { file: "src/components/portal/pro-payments-ledger-panel.tsx" },
    { file: "src/components/portal/pro-applications.tsx" },
    { file: "src/components/portal/workspace-invite-sheet.tsx" },
    { file: "src/components/portal/uploaded-lease-review-modal.tsx" },
  ];

  it("every adopted dialog renders through PortalDialog, not a hand-rolled Modal footer", () => {
    for (const { file, marker } of adopted) {
      const source = readSource(file);
      expect(source, `${file} does not import PortalDialog`).toMatch(
        /from "@\/components\/portal\/portal-dialog"/,
      );
      const scoped = marker ? source.slice(source.indexOf(marker)) : source;
      expect(scoped, `${file} does not render <PortalDialog`).toContain("<PortalDialog");
    }
  });

  it("the listing wizard's save-failed dialog reuses ListingSaveFailedDialog, not a hand-rolled three-button Modal", () => {
    // Deliberately not PortalDialog — the shared save-failed dialog needs
    // alertdialog semantics and stacking above the wizard's own full-screen
    // overlay (see save-failed-dialog.tsx's own header comment). The
    // regression this guards is the wizard growing its OWN inline Modal with
    // a third footer button again.
    const source = readSource("src/components/portal/listing-wizard-v2/index.tsx");
    expect(source).toMatch(/from "@\/components\/portal\/listing-wizard-v2\/save-failed-dialog"/);
    expect(source).toContain("<ListingSaveFailedDialog");
    expect(source).not.toMatch(/from "@\/components\/ui\/modal"/);
  });

  it("the plan-limit gate opens a dialog, never a silent redirect to billing", () => {
    const source = readSource("src/components/portal/pro-properties.tsx");
    const branch = source.slice(
      source.indexOf("if (atPropertyLimit) {"),
      source.indexOf("return false;\n    }\n    return true;"),
    );
    expect(branch).not.toMatch(/router\.push\(MANAGER_PLAN_PORTAL_URL\)/);
  });
});
