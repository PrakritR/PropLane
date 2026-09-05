"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { LeasePacketInlineEditor } from "@/components/portal/lease-packet-inline-editor";
import { ManagerApplicationReadonlyReview } from "@/components/portal/pro-application-readonly-review";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";

type LeaseReviewTabId = "manager-review" | "lease-review" | "application-info";

function leaseRowHasDocument(row: LeasePipelineRow): boolean {
  return Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
}

export function LeasePipelineReviewPanel({
  row,
  managerUserId,
  onSaved,
  onGenerateLease,
  generateLeaseDisabled,
  generateLeaseTitle,
}: {
  row: LeasePipelineRow;
  managerUserId?: string | null;
  onSaved: () => void;
  onGenerateLease: () => void;
  generateLeaseDisabled?: boolean;
  generateLeaseTitle?: string;
}) {
  const hasDocument = leaseRowHasDocument(row);
  const defaultTab: LeaseReviewTabId = hasDocument ? "lease-review" : "manager-review";
  const [activeTab, setActiveTab] = useState<LeaseReviewTabId>(defaultTab);

  useEffect(() => {
    setActiveTab(hasDocument ? "lease-review" : "manager-review");
  }, [row.id, hasDocument]);

  const applicationRow = useMemo((): DemoApplicantRow | null => {
    const axisId = row.axisId?.trim();
    if (axisId) {
      const byAxis = readManagerApplicationRows().find((candidate) => candidate.id.trim() === axisId);
      if (byAxis) return byAxis;
    }
    const email = row.residentEmail.trim().toLowerCase();
    if (!email) return null;
    return (
      readManagerApplicationRows().find(
        (candidate) => candidate.email?.trim().toLowerCase() === email,
      ) ?? null
    );
  }, [row.axisId, row.residentEmail, row.updatedAtIso]);

  const tabItems = useMemo(() => {
    const items: { id: LeaseReviewTabId; label: string; dataAttr: string }[] = [
      {
        id: "manager-review",
        label: "Manager review",
        dataAttr: "lease-review-tab-manager",
      },
      {
        id: "lease-review",
        label: "Lease review",
        dataAttr: "lease-review-tab-lease",
      },
    ];
    if (applicationRow || row.application) {
      items.push({
        id: "application-info",
        label: "Application info",
        dataAttr: "lease-review-tab-application",
      });
    }
    return items;
  }, [applicationRow, hasDocument, row.application]);

  const leaseBadge = row.leaseKind === "joint_bundle" ? "Joint bundle" : "1 lease";

  return (
    <div
      className="mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
      data-attr="lease-pipeline-review-panel"
    >
      <div className="border-b border-border bg-accent/20 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {activeTab === "lease-review" ? "Lease review" : "Manager review"}
          </h3>
          <Badge tone="info">{leaseBadge}</Badge>
          <span className="text-xs text-muted">{row.unit?.trim() || row.residentName}</span>
        </div>
        <div className="mt-3 -mx-1">
          <LocalDestinationNav
            items={tabItems.map((item) => ({
              id: item.id,
              label: item.label,
              dataAttr: item.dataAttr,
            }))}
            activeId={activeTab}
            onChange={(id) => {
              if (id === "lease-review" && !hasDocument) return;
              setActiveTab(id as LeaseReviewTabId);
            }}
            ariaLabel="Lease review sections"
            className="rounded-xl border border-border bg-background p-1"
          />
        </div>
      </div>

      <div className="p-3 sm:p-4">
        {activeTab === "manager-review" ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-border bg-accent/30 px-3 py-2.5 text-sm text-muted">
              <span aria-hidden className="text-base leading-none">
                📄
              </span>
              <p>
                <span className="font-medium text-foreground">Manager review</span> — confirm rent,
                deposit, and dates, then generate the lease document. Send is available only after
                generation under Lease review.
              </p>
            </div>
            <LeasePacketInlineEditor
              row={row}
              managerUserId={managerUserId}
              layout="manager-review"
              autoSave
              onSaved={() => onSaved()}
              onGenerateLease={onGenerateLease}
              generateLeaseDisabled={generateLeaseDisabled}
              generateLeaseTitle={generateLeaseTitle}
            />
          </div>
        ) : null}

        {activeTab === "lease-review" ? (
          hasDocument ? (
            <LeaseDocumentPreview row={row} flow className="mt-0" />
          ) : (
            <p className="text-sm text-muted">
              Generate a lease document from Manager review first.
            </p>
          )
        ) : null}

        {activeTab === "application-info" ? (
          applicationRow ? (
            <ManagerApplicationReadonlyReview
              partial={applicationRow.application ?? {}}
              assignedPropertyId={applicationRow.assignedPropertyId}
              assignedRoomChoice={applicationRow.assignedRoomChoice}
              embedded
            />
          ) : row.application ? (
            <p className="text-sm text-muted">
              Application answers are stored on this lease row. Open the linked application for the
              full review.
            </p>
          ) : (
            <p className="text-sm text-muted">No application linked to this lease.</p>
          )
        ) : null}
      </div>
    </div>
  );
}
