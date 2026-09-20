// @vitest-environment jsdom
//
// Incoming header Add charge stays visible with an empty pipeline and with an
// empty workspace. The server still refuses unauthorized writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";

vi.stubGlobal(
  "fetch",
  async () =>
    new Response(JSON.stringify({ rows: [], records: [], messages: [], settings: null, ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

vi.mock("@/components/portal/payment-schedule-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/portal/payment-schedule-ui")>()),
  useScheduledPaymentMessages: () => ({
    messages: [],
    settings: null,
    reload: () => Promise.resolve(),
    setSettings: () => {},
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/payments",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-header-add", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => [],
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-portfolio-access")>()),
  ownedPropertyIdsForUser: () => new Set<string>(),
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
  buildManagerPropertyFilterOptions: () => [],
  applicationVisibleToPortalUser: () => false,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  readExtraListingsForUser: () => [],
  readPendingManagerPropertiesForUser: () => [],
  readScopedExtraListings: () => [],
  readAllExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ManagerPayments } from "@/components/portal/pro-payments";

afterEach(() => {
  setWorkspaceSelection(null);
});

function incomingHtml() {
  return renderToStaticMarkup(<ManagerPayments direction="incoming" bucket="pending" />);
}

describe("Incoming header Add charge", () => {
  it("renders with 0 pipeline houses", () => {
    setWorkspaceSelection({
      activeWorkspaceId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "My workspace",
          ownerUserId: "mgr-header-add",
          owned: true,
          isDefault: true,
          propertyIds: ["house-1"],
          propertyLabels: { "house-1": "5257 Brooklyn" },
          propertyPermissions: {},
        },
      ],
    });
    const html = incomingHtml();
    expect(html).toContain('data-attr="payments-add-top"');
    expect(html).toContain('aria-label="Add charge"');
    expect(html).toContain('data-attr="payments-empty-add"');
    // Every list tab has the search box in its command bar.
    expect(html).toContain('data-attr="payments-search"');
  });

  it("renders with 0 workspace houses", () => {
    setWorkspaceSelection({
      activeWorkspaceId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "My workspace",
          ownerUserId: "mgr-header-add",
          owned: true,
          isDefault: true,
          propertyIds: [],
          propertyLabels: {},
          propertyPermissions: {},
        },
      ],
    });
    const html = incomingHtml();
    expect(html).toContain('data-attr="payments-add-top"');
    expect(html).toContain('aria-label="Add charge"');
    expect(html).toContain('data-attr="payments-empty-add"');
  });
});
