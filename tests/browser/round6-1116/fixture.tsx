/**
 * Renders the REAL round-6 surfaces in a browser with the real Tailwind CSS, so the plan's
 * promises can be SEEN: the dashboard's KPI tiles and Needs attention panel in each read state
 * (loading skeleton / "Unavailable · Retry" / an honest answered zero), the tour confirm dialog
 * naming the guest instead of their raw address, and the manager inbox answering every Send.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";
import {
  AttentionPanel,
  KpiCard,
  type ReadState,
} from "../../../src/components/portal/pro-dashboard-kpis";
import { PortalNotificationPreviewModal } from "../../../src/components/portal/portal-notification-preview-modal";
import { ManagerInbox } from "../../../src/components/portal/pro-inbox";
import type { AttentionRow } from "../../../src/components/portal/pro-dashboard-kpis";

const ATTENTION_ROWS: AttentionRow[] = [
  { id: "applications", title: "3 applications ready to review", actionLabel: "Review", href: "#", tone: "pending" },
  { id: "leases", title: "Lease for Ada Lovelace waiting on you", actionLabel: "Sign", href: "#", tone: "info" },
];

/** The dashboard's own four tiles, with the values a live manager's reads produce. */
function Kpis({ state }: { state: ReadState }) {
  const ready = state === "ready";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard
        label="Occupancy"
        state={state}
        onRetry={() => {}}
        value={ready ? "0%" : "—"}
        unit={ready ? "0 / 6 beds" : undefined}
        detail="Beds with someone in them today"
        delta={null}
        href="#"
        dataAttr="dashboard-kpi-occupancy"
      />
      <KpiCard
        label="Rent collected"
        state={state}
        onRetry={() => {}}
        value={ready ? "$0" : "—"}
        unit={ready ? "of $4,200 billed" : undefined}
        detail="Paid this period"
        delta={null}
        href="#"
        dataAttr="dashboard-kpi-collected"
      />
      <KpiCard
        label="Open requests"
        state={state}
        onRetry={() => {}}
        value={ready ? "0" : "—"}
        unit={ready ? "none open" : undefined}
        detail="Services and maintenance still open"
        delta={null}
        href="#"
        dataAttr="dashboard-kpi-requests"
      />
      <KpiCard
        label="Applications ready"
        state={state}
        onRetry={() => {}}
        value={ready ? "0" : "—"}
        detail="Waiting on a decision"
        delta={null}
        href="#"
        dataAttr="dashboard-kpi-applications"
      />
    </div>
  );
}

function Dashboard({ state, rows }: { state: ReadState; rows: AttentionRow[] }) {
  return (
    <div className="min-h-screen bg-[var(--background)] p-5" data-attr="round6-dashboard">
      <Kpis state={state} />
      <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
        <AttentionPanel rows={rows} state={state} onRetry={() => {}} />
      </div>
    </div>
  );
}

function TourConfirm({ named }: { named: boolean }) {
  return (
    <PortalNotificationPreviewModal
      open
      title="Confirm tour"
      onClose={() => {}}
      recipient="gabriel@example.com"
      recipientName={named ? "Gabriel Guest" : undefined}
      recipientPhone="+1 (206) 555-0100"
      subject="Your tour at 5259 Brooklyn is confirmed"
      body={"Hi Gabriel,\n\nYour tour of Room 3 at 5259 Brooklyn is confirmed for Friday, Nov 20 at 10:00 AM.\n\nSee you then."}
      skipMessageLabel="Don't message guest"
      showChannelPicker
      emailAvailable
      smsAvailable
      defaultViaSms={false}
      confirmLabel="Confirm and send"
      confirmLabelWithoutMessage="Confirm without a message"
      onConfirm={() => {}}
    />
  );
}

/** The real manager inbox, on a conversation that only ever texted the work number. */
function Inbox({ phone }: { phone: boolean }) {
  return (
    <div className="h-screen bg-[var(--background)] p-4" data-attr="round6-inbox">
      <ManagerInbox
        tabId="unopened"
        smsUiEnabled
        smsRecipients={
          phone
            ? [{ phone: "+12065550100", residentEmail: null, residentUserId: null, conversationKey: null } as never]
            : []
        }
      />
    </div>
  );
}

function Fixture() {
  const which = new URLSearchParams(location.search).get("case") ?? "dash-ready";
  if (which === "inbox-phone") return <Inbox phone />;
  if (which === "inbox-unreachable") return <Inbox phone={false} />;
  if (which === "dash-loading") return <Dashboard state="loading" rows={[]} />;
  if (which === "dash-failed") return <Dashboard state="failed" rows={[]} />;
  if (which === "dash-ready-empty") return <Dashboard state="ready" rows={[]} />;
  if (which === "dash-ready") return <Dashboard state="ready" rows={ATTENTION_ROWS} />;
  if (which === "tour-before") return <TourConfirm named={false} />;
  return <TourConfirm named />;
}

createRoot(document.getElementById("root")!).render(
  <AppUiProvider>
    <Fixture />
  </AppUiProvider>,
);
