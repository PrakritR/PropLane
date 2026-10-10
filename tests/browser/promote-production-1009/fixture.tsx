import React from "react";
import { createRoot } from "react-dom/client";
import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";
import { WorkspaceProvider } from "../../../src/components/portal/workspace-provider";
import { PortalFilterSortSheet } from "../../../src/components/portal/portal-filter-sort-sheet";
import { GrowthEngageTab } from "../../../src/components/portal/growth-engage-tab";
import { VendorServicesPanel } from "../../../src/components/portal/vendor-services-panel";

const surface = new URLSearchParams(location.search).get("surface") ?? "filter-sheet";

/**
 * The phone Filter sheet, mounted under the real `WorkspaceProvider` exactly as
 * a portal list page mounts it. The provider's first `GET /api/workspaces`
 * answer used to re-key this subtree and throw the open sheet away; the spec
 * taps Filter while that read is still in flight and then lets it land.
 */
function FilterSheetSurface() {
  return (
    <WorkspaceProvider>
      <div className="mx-auto w-full max-w-[420px] px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground">Properties</h1>
          <PortalFilterSortSheet filterFieldCount={2} dataAttr="properties-filter-open">
            <div className="space-y-4">
              <label className="block text-sm font-medium text-foreground">
                Stage
                <select className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  <option>Any stage</option>
                  <option>Listed</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-foreground">
                Updated
                <select className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  <option>Any time</option>
                  <option>Last 7 days</option>
                </select>
              </label>
            </div>
          </PortalFilterSortSheet>
        </div>
        <div className="space-y-2">
          {["5257 Brooklyn Ave", "5259 Brooklyn Ave", "4709A 8th Ave NE"].map((name) => (
            <div key={name} className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground">
              {name}
            </div>
          ))}
        </div>
      </div>
    </WorkspaceProvider>
  );
}

function Surface() {
  if (surface === "filter-sheet") return <FilterSheetSurface />;
  if (surface === "engage")
    return (
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <GrowthEngageTab />
      </div>
    );
  if (surface === "vendor-services")
    return (
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <VendorServicesPanel />
      </div>
    );
  return <p>unknown surface: {surface}</p>;
}

createRoot(document.getElementById("root")!).render(
  <AppUiProvider>
    <Surface />
  </AppUiProvider>,
);
