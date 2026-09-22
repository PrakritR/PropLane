// @vitest-environment jsdom
//
// PRP-495 / PRP-497: the Properties "+" always started a blank listing before
// this fix removed the special case that resumed the first-listing draft
// (`readAdminPropertyRows(5, …)[0]`) whenever the portfolio still needed
// onboarding — so a manager with one half-done draft who wanted to start a
// SECOND property kept reopening the same half-filled one from "+", with no
// way to start fresh except the Drafts tab. This renders the real
// `ManagerProperties` surface (same harness as
// `manager-property-limit-banner-evidence.test.tsx`) against a seeded draft
// and drives the real "+" menu. Each test uses its own manager id — the demo
// store this reads/writes is a persistent module-level cache, not something
// `localStorage.clear()` alone resets between tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerProperties } from "@/components/portal/pro-properties";

let managerId = "";

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: managerId, email: "fresh-add@example.test", ready: true }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/portal/properties",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerPortfolioFromServer: async () => true,
}));

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/manager/subscription")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tier: null, effectiveTier: "starter", propertyLimit: null, accountLinkLimit: null, planUnknown: false }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ snapshot: null }) } as unknown as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function openAddMenu() {
  const trigger = document.querySelector('[data-attr="manager-properties-add-top"]') as HTMLElement;
  expect(trigger).toBeTruthy();
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByText("Add property")).toBeTruthy());
  fireEvent.click(screen.getByText("Add property"));
}

async function seedDraft(id: string, buildingName: string) {
  const { createNewListingWizardSubmission } = await import("@/lib/manager-listing-submission");
  const { saveManagerPropertyDraftToServer } = await import("@/lib/demo-admin-property-inventory");
  const draftId = await saveManagerPropertyDraftToServer(
    { ...createNewListingWizardSubmission(), buildingName },
    id,
    { stepIndex: 0, maxStepReached: 0 },
  );
  expect(draftId).toBeTruthy();
  return draftId as string;
}

describe("Properties '+' always starts a blank listing (PRP-495 / PRP-497)", () => {
  it("opens blank on the first click and again on a second click, even with an existing draft", async () => {
    managerId = "mgr-add-starts-fresh-1";
    window.history.replaceState(null, "", "/portal/properties/all");
    stubFetch();
    await seedDraft(managerId, "Half-done House");

    render(
      <AppUiProvider>
        <div className="portal-shell">
          <ManagerProperties stage="all" />
        </div>
      </AppUiProvider>,
    );

    // First click: the existing draft must NOT be the one that opens.
    await openAddMenu();
    const nameInput = (await screen.findByPlaceholderText("Magnolia House")) as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(screen.queryByDisplayValue("Half-done House")).toBeNull();

    // Close without typing anything (untouched — nothing to save) and open again.
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(screen.queryByPlaceholderText("Magnolia House")).toBeNull());

    await openAddMenu();
    const nameInputAgain = (await screen.findByPlaceholderText("Magnolia House")) as HTMLInputElement;
    expect(nameInputAgain.value).toBe("");
    expect(screen.queryByDisplayValue("Half-done House")).toBeNull();
  });

  it("the Drafts tab still opens the existing draft by its own row", async () => {
    managerId = "mgr-add-starts-fresh-2";
    window.history.replaceState(null, "", "/portal/properties/drafts");
    stubFetch();
    const draftId = await seedDraft(managerId, "Half-done House");

    const { readAdminPropertyRows } = await import("@/lib/demo-admin-property-inventory");
    const row = readAdminPropertyRows(5, managerId).find((r) => r.adminRefId === draftId);
    expect(row?.submission?.buildingName).toBe("Half-done House");

    render(
      <AppUiProvider>
        <div className="portal-shell">
          <ManagerProperties stage="drafts" />
        </div>
      </AppUiProvider>,
    );

    // The Drafts row for the seeded draft is on screen, by its own name — this
    // fix only changes the "+" path; resuming from the Drafts row is untouched.
    await waitFor(() => expect(screen.getByText("Half-done House")).toBeTruthy());
  });
});
