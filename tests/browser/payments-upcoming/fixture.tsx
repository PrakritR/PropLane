import React from "react";
import { createRoot } from "react-dom/client";
import { ManagerPayments } from "../../../src/components/portal/pro-payments";
import { ResidentPaymentsPanel } from "../../../src/components/portal/resident-payments-panel";
import { WorkspaceProvider } from "../../../src/components/portal/workspace-provider";
import { readChargesForResident, readHouseholdCharges } from "../../../src/lib/household-charges";
import { residentCanSeeCharge, residentVisibleCharges } from "../../../src/lib/household-charge-visibility";

/** Debug hooks for the spec: inspect the in-page store the panels read from. */
(window as unknown as { __hc: unknown }).__hc = { readChargesForResident, readHouseholdCharges, residentCanSeeCharge, residentVisibleCharges };

/**
 * `?surface=manager|resident` picks the portal; `?route=/portal/payments/incoming/pending[/<id>]`
 * (or `/resident/payments/pending[/<id>]`) mirrors the app-router params the real
 * `renderPortalSection` derives. Charges arrive from the intercepted
 * `GET /api/portal-household-charges` (see `seed.ts`), so the store hydrates exactly
 * the way it does against the server.
 */
const params = new URLSearchParams(location.search);
const surface = params.get("surface") === "resident" ? "resident" : "manager";
const route = params.get("route") ?? (surface === "resident" ? "/resident/payments/pending" : "/portal/payments/incoming/pending");

(window as unknown as { __session: unknown }).__session =
  surface === "resident"
    ? { userId: "res-maya", email: "maya@example.com", ready: true }
    : { userId: "mgr-fixture", email: "manager@example.com", ready: true };

function ManagerSurface() {
  const parts = route.replace(/^\/portal\/payments\/?/, "").split("/").filter(Boolean);
  const direction = (parts[0] === "outgoing" ? "outgoing" : "incoming") as "incoming" | "outgoing";
  const bucket = (["pending", "overdue", "paid"].includes(parts[1] ?? "") ? parts[1] : "pending") as "pending" | "overdue" | "paid";
  const paymentId = parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const paymentTab = parts[3] ? decodeURIComponent(parts[3]) : undefined;
  return (
    <WorkspaceProvider>
      <ManagerPayments direction={direction} bucket={bucket} basePath="/portal" paymentId={paymentId} paymentTab={paymentTab} />
    </WorkspaceProvider>
  );
}

function ResidentSurface() {
  const parts = route.replace(/^\/resident\/payments\/?/, "").split("/").filter(Boolean);
  const bucket = (["pending", "overdue", "paid"].includes(parts[0] ?? "") ? parts[0] : "pending") as "pending" | "overdue" | "paid";
  const chargeId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  return <ResidentPaymentsPanel bucket={bucket} basePath="/resident" chargeId={chargeId} />;
}

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh" }}>
    {surface === "resident" ? <ResidentSurface /> : <ManagerSurface />}
  </main>,
);
