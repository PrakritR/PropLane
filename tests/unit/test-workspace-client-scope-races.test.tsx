// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";

const actor = vi.hoisted(() => ({ userId: "resident-a", ready: true, email: "a@example.test" }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => actor }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => actor }));
vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => false }));
vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("@/hooks/use-visual-viewport-bottom-inset", () => ({ useVisualViewportBottomInset: () => 0 }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  AssistantConversationProvider: ({ children }: { children: ReactNode }) => children,
  useOptionalAssistantConversation: () => ({ messages: [], attachments: [], threads: [], hydrateArchive: vi.fn() }),
}));
vi.mock("@/components/portal/portal-metrics", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/portal/portal-metrics")>(),
  ManagerPortalPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PORTAL_INLINE_UNLOCK_NOTICE_CLASS: "",
  PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS: "",
}));
vi.mock("@/components/portal/resident-add-service-modal", () => ({
  ResidentAddServiceModal: ({ availableOffers, resolveFilingIds }: {
    availableOffers: ManagerListingServiceOption[];
    resolveFilingIds: () => { propertyId: string; managerUserId: string };
  }) => <output data-testid="resident-offers">{JSON.stringify({ availableOffers, filing: resolveFilingIds() })}</output>,
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "test-work-orders",
  readManagerWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => true,
  deleteManagerWorkOrderRow: vi.fn(), updateManagerWorkOrder: vi.fn(),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "test-applications",
  readManagerApplicationRows: () => [], syncManagerApplicationsFromServer: async () => true,
}));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "test-leases", findLeaseForResidentEmail: () => null,
  hasBothLeaseSignatures: () => false, syncLeasePipelineFromServer: async () => true,
}));
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "test-services", readServiceRequestsForResident: () => [],
  syncServiceRequestsFromServer: async () => true, deleteServiceRequest: vi.fn(),
  updateServiceRequest: vi.fn(), hasDeposit: () => false, isServiceRequestFeePaid: () => false,
}));
// Keep the real catalog scope, own-property request and fencing. Only the
// unrelated manager bulk sync is stubbed to isolate these deferred responses.
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/demo-property-pipeline")>(),
  syncPropertyPipelineFromServer: async () => true,
}));

import { AxisAssistant } from "@/components/portal/axis-assistant";
import { ResidentServicesPanel } from "@/components/portal/resident-services-panel";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import { resetPropertyPipelineClientCache } from "@/lib/demo-property-pipeline";

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function capability(id: string) {
  return response({ capability: { targets: [{ listingId: id, managerUserId: "manager", title: id, address: id }] } });
}
function ownProperty(id: string) {
  return response({ property: { id }, propertyId: id, managerUserId: `manager-${id}`,
    serviceRequestOptions: [{ id, name: id, available: true }] });
}
function ConfigProbe() {
  const config = usePortalAssistantConfig();
  return <>
    <output data-testid="assistant-config">{JSON.stringify(config)}</output>
    <button onClick={() => {
      config?.smsTest?.onSelectTarget(config.smsTest.targets[0]?.listingId ?? "");
      config?.smsTest?.onToggle();
    }}>Start test</button>
  </>;
}
function assistant() {
  return <AxisAssistant endpoint="/api/agent/resident-chat" smsTestPortal="resident"><ConfigProbe /></AxisAssistant>;
}
function switchActor(userId: string) {
  actor.userId = userId;
  actor.email = `${userId}@example.test`;
  setPortalSessionViewer(userId || null);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/resident/services");
  window.localStorage.clear();
  window.sessionStorage.clear();
  setWorkspaceSelection(null);
  switchActor("resident-a");
  resetPropertyPipelineClientCache();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("rendered capability lifetime", () => {
  it("clears an active target synchronously on actor change and refetches capability", async () => {
    const next = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(capability("target-a")).mockReturnValueOnce(next.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = render(assistant());
    await waitFor(() => expect(screen.getByTestId("assistant-config")).toHaveTextContent("target-a"));
    fireEvent.click(screen.getByRole("button", { name: "Start test" }));
    expect(screen.getByTestId("assistant-config")).toHaveTextContent("/api/agent/sms-test");
    act(() => { switchActor("resident-b"); });
    view.rerender(assistant());
    expect(screen.getByTestId("assistant-config")).not.toHaveTextContent("target-a");
    expect(screen.getByTestId("assistant-config")).toHaveTextContent("/api/agent/resident-chat");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { next.resolve(capability("target-b")); });
    await waitFor(() => expect(screen.getByTestId("assistant-config")).toHaveTextContent("target-b"));
  });

  it("rejects late workspace A success and failure after A-to-B-to-A", async () => {
    setWorkspaceSelection({ activeWorkspaceId: "a", workspaces: [] });
    const old = deferred(); const middle = deferred(); const fresh = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(fresh.promise);
    vi.stubGlobal("fetch", fetcher);
    render(assistant());
    act(() => setWorkspaceSelection({ activeWorkspaceId: "b", workspaces: [] }));
    act(() => setWorkspaceSelection({ activeWorkspaceId: "a", workspaces: [] }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await act(async () => { fresh.resolve(capability("fresh-a")); });
    await waitFor(() => expect(screen.getByTestId("assistant-config")).toHaveTextContent("fresh-a"));
    await act(async () => { old.resolve(capability("stale-a")); middle.resolve(response({ error: "stale failure" }, 500)); });
    expect(screen.getByTestId("assistant-config")).toHaveTextContent("fresh-a");
    expect(screen.getByTestId("assistant-config")).not.toHaveTextContent("stale");
  });
});

describe("rendered resident service hydration", () => {
  it("does not accept old resident offers or filing scope after logout/login", async () => {
    const old = deferred(); const current = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ResidentServicesPanel basePath="/resident" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => { switchActor(""); switchActor("resident-b"); });
    view.rerender(<ResidentServicesPanel basePath="/resident" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { current.resolve(ownProperty("property-b")); });
    await waitFor(() => expect(screen.getByTestId("resident-offers")).toHaveTextContent("property-b"));
    await act(async () => { old.resolve(ownProperty("property-a")); });
    expect(screen.getByTestId("resident-offers")).not.toHaveTextContent("property-a");
    expect(screen.getByTestId("resident-offers")).toHaveTextContent("manager-property-b");
  });

  it("hides existing offers immediately and reloads on same-actor workspace switch", async () => {
    const next = deferred();
    const fetcher = vi.fn().mockResolvedValueOnce(ownProperty("property-a")).mockReturnValueOnce(next.promise);
    vi.stubGlobal("fetch", fetcher);
    render(<ResidentServicesPanel basePath="/resident" />);
    await waitFor(() => expect(screen.getByTestId("resident-offers")).toHaveTextContent("property-a"));
    act(() => setWorkspaceSelection({ activeWorkspaceId: "new-workspace", workspaces: [] }));
    expect(screen.getByTestId("resident-offers")).not.toHaveTextContent("property-a");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { next.resolve(ownProperty("property-b")); });
    await waitFor(() => expect(screen.getByTestId("resident-offers")).toHaveTextContent("property-b"));
  });
});
