import React from "react";
import { createRoot } from "react-dom/client";
import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";
import { FormsList } from "../../../src/components/portal/move-in-forms/forms-list";
import { RecordCommunicationSection } from "../../../src/components/portal/record-communication-section";
import { SendNewLeaseModal } from "../../../src/components/portal/lease-send-new-modal";
import { ResidentFormsSection } from "../../../src/components/portal/move-in-forms/resident-move-in-forms";
import { ResidentFormsLock } from "../../../src/components/portal/move-in-forms/resident-forms-lock";
import type { LeasePipelineRow } from "../../../src/lib/lease-pipeline-storage";

const LEASE_ROW = {
  id: "lease-1",
  axisId: "AXIS-1",
  residentName: "Maya Chen",
  residentEmail: "maya@example.com",
  unit: "Room 1 · Alder Row",
  propertyId: "prop-1",
  status: "Fully Signed",
  bucket: "signed",
  signedRentLabel: "$1,150 / month",
  application: { leaseTerm: "12 Months", leaseStart: "2026-10-05", leaseEnd: "2027-10-05" },
} as unknown as LeasePipelineRow;

function Surface() {
  const surface = new URLSearchParams(location.search).get("surface") ?? "forms";

  if (surface === "forms" || surface === "forms-completed")
    return (
      <FormsList
        userId="mgr-1"
        bucket={surface === "forms-completed" ? "completed" : "pending"}
        basePath="/portal"
      />
    );

  if (surface === "forms-record")
    return <FormsList userId="mgr-1" bucket="pending" basePath="/portal" applicationId="AXIS-1" />;

  if (surface === "communication")
    return (
      // `fill` is the lane's change: every record Communication section fills the page.
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <RecordCommunicationSection
          role="manager"
          fill
          recordRef={{ kind: "lease", id: "lease-1", label: "Lease #100" }}
          contactIds={["maya@example.com"]}
          contactName="Maya Chen"
          propertyId="prop-1"
        />
      </div>
    );

  if (surface === "resident-forms") return <ResidentFormsSection />;

  if (surface === "resident-lock")
    return (
      <div style={{ display: "grid", gap: 24, padding: 24 }}>
        {/* The lock where an unsubmitted form holds Move-in details / lease signing back. */}
        <ResidentFormsLock formId="copy-1" />
        {/* Fail closed: the forms read itself failed, so the lock holds and names no form. */}
        <ResidentFormsLock readFailed />
      </div>
    );

  if (surface === "send-new-lease")
    return (
      <SendNewLeaseModal
        row={LEASE_ROW}
        managerUserId="mgr-1"
        onClose={() => {}}
        onCreated={() => {}}
        onNeedsSendScreen={() => {}}
      />
    );

  return <p>unknown surface</p>;
}

createRoot(document.getElementById("root")!).render(
  <AppUiProvider>
    <Surface />
  </AppUiProvider>,
);
