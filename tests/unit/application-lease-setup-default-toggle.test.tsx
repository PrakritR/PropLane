// @vitest-environment jsdom
//
// F007: the Setup step's "Default for this property" toggle was reachable
// only once an application/lease template already existed (`edit` mode) —
// a brand-new ("add") one had no id yet, so the whole toggle was missing.
// Both editors now generate a pending id up front and reuse it as the
// created template's real id at the footer commit, so the toggle (and any
// pick made through it) is reachable from the very first "add" open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

/** Stubs GET (no settings yet) and echoes back whatever `leasingPipeline` a PATCH sends. */
function stubFormSetupFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/api/portal/manager-application-settings")) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { leasingPipeline?: unknown };
        return { ok: true, status: 200, json: async () => ({ leasingPipeline: body.leasingPipeline }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  stubFormSetupFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F007: Add application Setup has the Default toggle", () => {
  it("shows the toggle before the template is ever saved, and patches a real (non-empty) pending id", async () => {
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Add application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="prop-1"
        templateEditorMode="add"
        applicationTemplate={null}
        templates={[]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Add application" });
    jumpRail("setup");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    const toggle = screen.getByRole("switch", { name: "Default application for this property" });
    fireEvent.click(toggle);

    await waitFor(() => {
      const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body)) as {
        leasingPipeline?: { defaultApplicationTemplateId?: string | null };
      };
      expect(body.leasingPipeline?.defaultApplicationTemplateId).toMatch(/^app-tpl-/);
    });
  });
});

describe("F007: New lease Setup has the Default toggle", () => {
  it("shows the toggle before the lease is ever saved, and patches a real (non-empty) pending id", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        templates={[]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "New lease" });
    jumpRail("setup");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    const toggle = screen.getByRole("switch", { name: /Default .* lease for this property/ });
    fireEvent.click(toggle);

    await waitFor(() => {
      const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body)) as {
        leasingPipeline?: { defaultLeaseTemplateId?: string | null };
      };
      expect(body.leasingPipeline?.defaultLeaseTemplateId).toMatch(/^lease-tpl-/);
    });
  });
});
