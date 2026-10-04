// @vitest-environment jsdom
//
// Settings -> Forms (D1): the workspace Forms library page, the tour-order control on the
// application form's first step, and the route that stores the library.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { LeasingFormsPanel, leasingFormRowFacts } from "@/components/portal/leasing-forms-panel";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";

let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/profile",
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", ready: true }) }));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const SLICE = { disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "standard" as const };
const STANDARD: PropertyApplicationTemplate = {
  ...createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" }),
  tourOrder: "before_tour",
  draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(SLICE),
};
const QUICK: PropertyApplicationTemplate = {
  ...createPropertyApplicationTemplate({ kind: "short-term", label: "Quick stay application" }),
  draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(SLICE),
};
const LEASE = createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease", source: "axis_default" });

let putBodies: Array<{ library: { applications: PropertyApplicationTemplate[]; leases: unknown[] } }>;

beforeEach(() => {
  search = "";
  putBodies = [];
  clearAllWorkspaceDrafts();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/portal/leasing-forms")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          putBodies.push(body);
          return { ok: true, status: 200, json: async () => ({ library: body.library }) } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ library: { applications: [STANDARD, QUICK], leases: [LEASE] } }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
  vi.unstubAllGlobals();
});

describe("Settings -> Forms page", () => {
  it("lists the workspace's application forms with their facts, on the Applications tab", async () => {
    render(<LeasingFormsPanel />);
    expect(await screen.findByText("Standard application")).toBeTruthy();
    expect(screen.getByText("Quick stay application")).toBeTruthy();
    expect(screen.queryByText("Long-term lease")).toBeNull();
    expect(screen.getAllByText("PropLane standard").length).toBe(2);
    // No form states a tour order: the workspace setting decides.
    expect(screen.queryByText("Before the tour")).toBeNull();
    expect(screen.getAllByText(/questions/).length).toBe(2);
    expect(screen.getAllByText(/0 properties/).length).toBe(2);
    // Header card: both tabs with counts, search, the one round +; no move-in tab.
    expect(document.querySelector('[data-attr="leasing-forms-tab-applications"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="leasing-forms-tab-leases"]')).toBeTruthy();
    expect(document.querySelector('[data-attr*="move-in"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Add application" })).toBeTruthy();
  });

  it("shows the lease forms on the Leases tab", async () => {
    search = "forms=leases";
    render(<LeasingFormsPanel />);
    expect(await screen.findByText("Long-term lease")).toBeTruthy();
    expect(screen.queryByText("Standard application")).toBeNull();
    expect(screen.getByRole("button", { name: "Add lease" })).toBeTruthy();
  });

  it("filters by the search box", async () => {
    render(<LeasingFormsPanel />);
    await screen.findByText("Standard application");
    fireEvent.change(screen.getByPlaceholderText("Search applications"), { target: { value: "quick" } });
    await waitFor(() => expect(screen.queryByText("Standard application")).toBeNull());
    expect(screen.getByText("Quick stay application")).toBeTruthy();
  });

  it("duplicates a form from its menu and saves the library without publication", async () => {
    render(<LeasingFormsPanel />);
    await screen.findByText("Standard application");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Standard application" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Standard application" }));
    const items = await screen.findAllByText("Duplicate");
    fireEvent.click(items[0]!);
    await waitFor(() => expect(putBodies.length).toBe(1));
    const labels = putBodies[0]!.library.applications.map((form) => form.label);
    expect(labels).toEqual(["Standard application", "Quick stay application", "Standard application copy"]);
    expect(putBodies[0]!.library.applications[2]!.tourOrder).toBe("before_tour");
  });

  it("row facts: an application states source and questions; a lease states source only", () => {
    const app = leasingFormRowFacts("application", STANDARD, 3);
    expect(app.place).toBe("Long-term · 3 properties");
    expect(app.glyphs).toHaveLength(2);
    const lease = leasingFormRowFacts("lease", LEASE, 1);
    expect(lease.place).toBe("Long-term · 1 property");
    expect(lease.glyphs).toHaveLength(1);
  });
});

function subWith(applications: PropertyApplicationTemplate[]): ManagerListingSubmissionV1 {
  return {
    ...createDefaultListingSubmission(),
    propertyLeaseTemplates: [LEASE],
    propertyApplicationTemplates: applications,
    propertyApplicationTemplatesExplicit: true,
  };
}

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

async function pick(trigger: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const node = await screen.findByText(option, { selector: '[role="option"] *, [role="option"]' });
  fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("application form, first step: no Tour order", () => {
  it("has no Tour order row, and saving migrates a stored per-form order to the workspace setting", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={subWith([STANDARD])}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={STANDARD}
        templates={[STANDARD]}
        signingOrder="application_then_lease"
        onPersistSubmission={persist}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Tour order" })).toBeNull();
    expect(screen.queryByText("Tour order")).toBeNull();
    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = (persist.mock.calls.at(-1)?.[0] as ManagerListingSubmissionV1).propertyApplicationTemplates ?? [];
    expect(saved.find((t) => t.id === STANDARD.id)!.tourOrder).toBe("workspace");
  });
});
