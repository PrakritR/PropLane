import React from "react";
import { createRoot } from "react-dom/client";
import { VendorWorkOrdersPanel } from "../../../src/components/portal/vendor-work-orders-panel";
import { VendorTaskList } from "../../../src/components/portal/vendor-task-list";
import { ManagerOutgoingInvoicesPanel } from "../../../src/components/portal/manager-outgoing-invoices-panel";
import { ManagerWorkOrdersPanel } from "../../../src/components/portal/pro-work-orders-panel";
import { VendorCommunication } from "../../../src/components/portal/vendor-communication";
import { completedJobLegacyPhoto, completedJobPrivatePhoto, MANAGER_ID, VENDOR_USER_ID } from "./seed";
import { useFixtureRoute } from "./stubs";
import { parseVendorWorkOrderTab } from "../../../src/lib/vendor-work-order-tabs";
import type { VendorTaskListTabId } from "../../../src/lib/portal-detail-routes";

/**
 * Vendor-ready fixture. The surface is picked by `?surface=`, the in-portal
 * route by `?route=` (the stub router moves it on every click, so a tab switch
 * or opening a job record is a real client navigation):
 *
 *  - `vendor-jobs`      the REAL vendor Services panel: the four stage tabs and a
 *                       job record (Schedule section = the visit picker / Complete).
 *  - `vendor-tasks`     the REAL vendor Tasks list with its per-row action.
 *  - `manager-outgoing` the REAL manager Outgoing payments list → Pay vendor → pay sheet.
 *  - `manager-service`  the REAL manager service record for a completed job, which is
 *                       where the vendor's completion photos are read back.
 *  - `vendor-inbox`     the REAL vendor Communication surface, opened on the manager's thread.
 */
const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "vendor-jobs";

(window as unknown as { __session: unknown }).__session =
  surface.startsWith("manager")
    ? { userId: MANAGER_ID, email: "taylor@example.com", ready: true }
    : { userId: VENDOR_USER_ID, email: "dispatch@harborplumbing.com", ready: true };

function VendorJobs() {
  const route = useFixtureRoute("/vendor/work-orders/assigned");
  const parts = route.replace(/^\/vendor\/work-orders\/?/, "").split("/").filter(Boolean);
  const first = parts[0] ?? "assigned";
  const stageTabs = ["open", "assigned", "scheduled", "completed", "find-work"];
  if (stageTabs.includes(first)) {
    return <VendorWorkOrdersPanel tabId={parseVendorWorkOrderTab(first)} />;
  }
  return <VendorWorkOrdersPanel workOrderId={first} workOrderDetailTab={(parts[1] ?? "service") as never} />;
}

function VendorTasks() {
  const route = useFixtureRoute("/vendor/tasks/in-progress");
  const last = route.split("/").filter(Boolean).pop() ?? "in-progress";
  const tabId = (last === "completed" ? "completed" : "in-progress") as VendorTaskListTabId;
  return <VendorTaskList tabId={tabId} />;
}

/** The manager's service record for a completed job: completion photos come back here. */
function ManagerService() {
  const route = useFixtureRoute("/portal/services/wo-done-private");
  const id = route.split("/").filter(Boolean).pop() ?? "wo-done-private";
  const rows = [completedJobPrivatePhoto(), completedJobLegacyPhoto()];
  return <ManagerWorkOrdersPanel allRows={rows} bucket="completed" workOrderId={id} />;
}

/** The vendor's Communication, deep-linked to the manager's thread. */
function VendorInbox() {
  const route = useFixtureRoute("/vendor/communication/active/thr-taylor");
  const parts = route.replace(/^\/vendor\/communication\/?/, "").split("/").filter(Boolean);
  const threadId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  return <VendorCommunication listSegment={(parts[0] ?? "active") as never} threadId={threadId} />;
}

function ManagerOutgoing() {
  const route = useFixtureRoute("/portal/outgoing/to-pay");
  const parts = route.replace(/^\/portal\/outgoing\/?/, "").split("/").filter(Boolean);
  // `/portal/outgoing/payment/<id>[/<tab>]` is the one payment as a record page.
  if (parts[0] === "payment" && parts[1]) {
    return <ManagerOutgoingInvoicesPanel paymentId={decodeURIComponent(parts[1])} paymentTab={parts[2] ?? "overview"} basePath="/portal" />;
  }
  return <ManagerOutgoingInvoicesPanel tabId={parts[0] ?? "to-pay"} basePath="/portal" />;
}

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh" }}>
    {surface === "vendor-tasks" ? (
      <VendorTasks />
    ) : surface === "vendor-inbox" ? (
      <VendorInbox />
    ) : surface === "manager-outgoing" ? (
      <ManagerOutgoing />
    ) : surface === "manager-service" ? (
      <ManagerService />
    ) : (
      <VendorJobs />
    )}
  </main>,
);
