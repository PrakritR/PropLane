import React from "react";
import { createRoot } from "react-dom/client";
import { ResidentPaymentsPanel } from "../../../src/components/portal/resident-payments-panel";
import { PortalPayoutsSettingsPage } from "../../../src/components/portal/portal-payouts-settings-page";
import { ApplicationPaymentReceiptCard } from "../../../src/components/portal/application-payment-receipt-card";
import { WorkspaceProvider } from "../../../src/components/portal/workspace-provider";
import { useFixtureRoute } from "../payments-upcoming/stubs";

/**
 * Central-payments fixture. `?surface=resident` mounts the REAL resident pay
 * surface (list → pay slots → the pay modal's method step); `?surface=payouts`
 * mounts the REAL manager Balance & payouts page, which is where the platform
 * source split (held on PropLane vs withdrawable on Stripe) and the classified
 * Withdraw sheet are visible. Everything else — charges, balance, destinations
 * — arrives through intercepted `/api/**` responses in the spec.
 */
const params = new URLSearchParams(location.search);
const requested = params.get("surface");
const surface = requested === "payouts" || requested === "receipts" ? requested : "resident";

(window as unknown as { __session: unknown }).__session =
  surface === "payouts"
    ? { userId: "mgr-fixture", email: "manager@example.com", ready: true }
    : { userId: "res-maya", email: "maya@example.com", ready: true };

function ResidentSurface() {
  const route = useFixtureRoute("/resident/payments/pending");
  const parts = route.replace(/^\/resident\/payments\/?/, "").split("/").filter(Boolean);
  const bucket = (["pending", "overdue", "paid"].includes(parts[0] ?? "") ? parts[0] : "pending") as
    | "pending"
    | "overdue"
    | "paid";
  const chargeId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  return <ResidentPaymentsPanel bucket={bucket} basePath="/resident" chargeId={chargeId} />;
}

/**
 * Two application-fee receipts side by side: one the central rail can state
 * exactly, and one historical row whose payment is ambiguous — the card says
 * "Payment needs review" and labels the figure "Amount recorded" rather than
 * claiming money was received.
 */
function ReceiptsSurface() {
  return (
    <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
      <section data-attr="receipt-exact">
        <h2 className="mb-2 text-sm font-semibold text-foreground">Central rail receipt</h2>
        <ApplicationPaymentReceiptCard applicationId="app-exact" />
      </section>
      <section data-attr="receipt-legacy">
        <h2 className="mb-2 text-sm font-semibold text-foreground">Legacy / ambiguous row</h2>
        <ApplicationPaymentReceiptCard applicationId="app-legacy" />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh" }}>
    {surface === "payouts" ? (
      <WorkspaceProvider>
        <PortalPayoutsSettingsPage portal="manager" />
      </WorkspaceProvider>
    ) : surface === "receipts" ? (
      <ReceiptsSurface />
    ) : (
      <ResidentSurface />
    )}
  </main>,
);
