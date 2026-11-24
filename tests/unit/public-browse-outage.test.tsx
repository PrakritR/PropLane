// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/manager-applications-storage", async (original) => ({
  ...await original<object>(),
  syncPublicApprovedApplicationsFromServer: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
import { ResidentHousingBrowse } from "@/components/marketing/resident-housing-browse";
import { resetPropertyPipelineClientCache, clearPrivateTestWorkspaceListings } from "@/lib/demo-property-pipeline";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";

beforeEach(() => {
  window.history.replaceState({}, "", "/rent/browse");
  window.localStorage.clear();
  window.sessionStorage.clear();
  setPortalSessionViewer(null);
  resetPropertyPipelineClientCache();
  clearPrivateTestWorkspaceListings();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const emptyCatalog = () => new Response(JSON.stringify({ listings: [] }), { headers: { "content-type": "application/json" } });

describe("public browse outage and recovery", () => {
  it.each(["503", "malformed", "network"])("shows Retry instead of zero homes after a %s failure", async (failure) => {
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("offline");
      return new Response(failure === "503" ? "upstream timeout" : "<html>gateway</html>", { status: failure === "503" ? 503 : 200 });
    }).mockImplementation(async () => emptyCatalog());
    vi.stubGlobal("fetch", fetcher);
    render(<ResidentHousingBrowse />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Homes did not load.");
    expect(screen.queryByText("No homes match")).not.toBeInTheDocument();
    expect(screen.queryByText("0 homes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("No homes match")).toBeInTheDocument());
    expect(screen.getByText("0 homes")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
