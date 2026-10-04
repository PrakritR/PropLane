// @vitest-environment jsdom
/**
 * My home › Inspections merges the move-in and move-out rosters. A current resident with no filed
 * report has a roster row under BOTH kinds, so the merged list must namespace its row keys by kind:
 * React logs "Encountered two children with the same key" on every load of /resident/move-in/*.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/move-in/inspections",
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u_mia", email: "mia@example.com", ready: true }),
}));
vi.mock("@/lib/inspections/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inspections/client")>();
  return {
    ...actual,
    loadInspectionList: vi.fn().mockResolvedValue({
      reports: [],
      residencies: [
        {
          id: "app-1",
          name: "Mia Resident",
          property: "Brooklyn House",
          room: "room-1",
          canCreate: true,
          propertyId: "p1",
          moveInDate: "2026-01-01",
          moveOutDate: "",
          occupancy: "current",
        },
      ],
    }),
  };
});

afterEach(cleanup);

describe("My home › Inspections list", () => {
  it("gives a current resident's move-in and move-out rows distinct keys", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      render(
        <AppUiProvider>
          <ResidentMoveInShell email="mia@example.com" resolved={null} activeTab="inspections" leaseSigned />
        </AppUiProvider>,
      );
      await waitFor(() => expect(screen.getAllByText(/Mia Resident/).length).toBeGreaterThan(1));
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => /same key/i.test(line))).toEqual([]);
  });
});
