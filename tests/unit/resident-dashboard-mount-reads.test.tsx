// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResidentDashboard } from "@/components/portal/resident-dashboard";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import { MANAGER_APPLICATIONS_EVENT, syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import { SERVICE_REQUESTS_EVENT, syncServiceRequestsFromServer } from "@/lib/service-requests-storage";

vi.mock("@/lib/demo/demo-session", async (load) => ({ ...await load<object>(), isDemoModeActive: () => false }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ ready: true, userId: "mount-viewer", email: "resident@example.test" }) }));
vi.mock("@/hooks/use-resident-portal-axis", () => ({ useResidentPortalAxisContext: () => ({ residentAxisId: "", profileManagerId: null, axisResolved: true }) }));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: false }) }));
vi.mock("@/lib/resident-tour-sync-client", () => ({ residentToursViewerKey: () => "mount-viewer", loadResidentToursForViewer: async () => [], RESIDENT_TOURS_CHANGED_EVENT: "tours" }));
vi.mock("@/lib/lease-pipeline-storage", async (load) => ({ ...await load<object>(), syncLeasePipelineFromServer: async () => [] }));
vi.mock("@/lib/manager-work-orders-storage", async (load) => ({ ...await load<object>(), syncManagerWorkOrdersFromServer: async () => [] }));
vi.mock("@/lib/household-charges", async (load) => ({ ...await load<object>(), syncHouseholdChargesFromServer: async () => [] }));
vi.mock("@/lib/portal-inbox-storage", async (load) => ({ ...await load<object>(), syncPersistedInboxFromServer: async () => [] }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it("the dashboard fetches resident slices once per mount and events/prop changes only render", async () => {
  setPortalSessionViewer("mount-viewer");
  document.cookie = "axis_active_portal=manager; path=/";
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ rows: [] }) });
  vi.stubGlobal("fetch", fetcher);
  const readCalls = () => fetcher.mock.calls.filter(([url]) => url === "/api/manager-applications" || url === "/api/manager-applications?scope=self" || url === "/api/portal-service-requests");
  await syncManagerApplicationsFromServer();
  await syncServiceRequestsFromServer();
  document.cookie = "axis_active_portal=resident; path=/";
  const view = render(<ResidentDashboard residentUserId="mount-viewer" residentEmail="resident@example.test" />);
  await waitFor(() => expect(readCalls()).toHaveLength(4));
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/manager-applications?scope=self")).toHaveLength(1);
  await act(async () => {
    window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
    window.dispatchEvent(new Event(SERVICE_REQUESTS_EVENT));
    window.dispatchEvent(new Event("storage"));
  });
  view.rerender(<ResidentDashboard applicationApproved residentUserId="mount-viewer" residentEmail="resident@example.test" />);
  await act(async () => {});
  expect(readCalls()).toHaveLength(4);
  view.unmount();
  render(<ResidentDashboard residentUserId="mount-viewer" residentEmail="resident@example.test" />);
  await waitFor(() => expect(readCalls()).toHaveLength(6));
});
