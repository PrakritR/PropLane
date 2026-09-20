// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { PortalRecordShareHost } from "@/components/portal/portal-record-share-host";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu, RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.history.replaceState({}, "", "/portal/applications/pending");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/portal/record-share-link")) {
        return new Response(JSON.stringify({ link: { url: "https://prop-lane.space/share/applications/AXIS-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ conversations: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

function Harness() {
  return (
    <AppUiProvider>
      <PortalRecordShareHost>
        <RecordActionContext.Provider
          value={{
            scope: "application-share",
            clear: () => {},
            actions: (
              <>
                <PortalRecordShareLinkButton
                  kind="application"
                  recordId="AXIS-1"
                  recordTitle="Ethan Wright"
                  dataAttr="applications-bulk-share"
                />
                <Button type="button">Run background check</Button>
              </>
            ),
          }}
        >
          <RecordActionMenu label="Ethan Wright" activate={() => {}} />
        </RecordActionContext.Provider>
      </PortalRecordShareHost>
    </AppUiProvider>
  );
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Ethan Wright" }), { key: "ArrowDown" });
}

describe("Share from a record ⋯ menu", () => {
  it("lists Run background check and Share", async () => {
    render(<Harness />);
    openMenu();
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Share");
    expect(menu.textContent).toContain("Run background check");
  });

  it("closes the menu before Share opens so the dialog is not under the blur", async () => {
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(<Harness />);
    openMenu();
    const share = await screen.findByRole("menuitem", { name: "Share" });
    dateSpy.mockReturnValue(1_000 + RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 1);
    fireEvent.click(share);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector('[data-testid="dropdown-menu-backdrop"]')).toBeNull();
    expect(await screen.findByText("Share application")).toBeTruthy();
    dateSpy.mockRestore();
  });
});
