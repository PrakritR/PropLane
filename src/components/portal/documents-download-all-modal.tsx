"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { downloadApplicationPdf } from "@/components/portal/pro-applications";
import { triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { downloadBlobFile } from "@/lib/portal-document-download";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { readCosignerSubmissionsForSignerAppId } from "@/lib/cosigner-submissions-storage";
import { DEMO_RESIDENT_NAME, isDemoModeActive } from "@/lib/demo/demo-session";
import { readChargesForResident } from "@/lib/household-charges";
import {
  findLeaseForResidentEmail,
  hasBothLeaseSignatures,
  readLeasePipeline,
  syncLeasePipelineFromServer,
  downloadLeaseFromRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  leaseVisibleToPortalUser,
} from "@/lib/manager-portfolio-access";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { receiptRowLabel } from "@/lib/resident-recorded-payments";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import { readUploadedOwnLeases } from "@/lib/resident-lease-upload";
import { cn } from "@/lib/utils";

type DownloadItem = {
  id: string;
  label: string;
  sublabel?: string;
  run: () => void | Promise<void>;
};

type DownloadSection = {
  id: string;
  label: string;
  items: DownloadItem[];
};

function applicationRoomLabel(row: DemoApplicantRow): string {
  const roomChoice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  return getRoomChoiceLabel(roomChoice);
}

function leaseHasDownloadableDocument(row: LeasePipelineRow): boolean {
  return Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
}

async function downloadApplicationRow(row: DemoApplicantRow): Promise<void> {
  const demoMode = isDemoModeActive();
  if (demoMode) {
    const { buildDemoApplicationPdfDataUrl } = await import("@/lib/demo/demo-document-files");
    const cosignerSubmissions =
      row.application?.hasCosigner === "yes" ? readCosignerSubmissionsForSignerAppId(row.id) : [];
    const url = await buildDemoApplicationPdfDataUrl(row, applicationRoomLabel(row) || undefined, cosignerSubmissions);
    const blob = await (await fetch(url)).blob();
    await downloadBlobFile({
      fileName: `rental-application-${row.id}.pdf`,
      mimeType: "application/pdf",
      blob,
      title: "Application",
    });
    return;
  }
  await downloadApplicationPdf(row);
}

function receiptPdfHref(date: string): string {
  const params = new URLSearchParams({ from: date, to: date, format: "pdf" });
  return `/api/reports/resident-ledger/export?${params.toString()}`;
}

async function downloadReceiptRow(
  row: { date: string; description: string; amount: string },
  demoMode: boolean,
): Promise<void> {
  if (demoMode) {
    const { buildDemoReceiptPdfDataUrl } = await import("@/lib/demo/demo-document-files");
    const url = await buildDemoReceiptPdfDataUrl({
      residentName: DEMO_RESIDENT_NAME,
      description: row.description,
      amountLabel: row.amount,
      dateLabel: row.date,
    });
    triggerDocumentDownload(url, `rental-receipt-${row.date}.pdf`);
    return;
  }
  triggerDocumentDownload(receiptPdfHref(row.date));
}

function buildManagerSections(userId: string | null): DownloadSection[] {
  if (!userId) return [];

  const applicationItems: DownloadItem[] = readManagerApplicationRows()
    .filter((row) => applicationVisibleToPortalUser(row, userId))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((row) => ({
      id: row.id,
      label: applicantDisplayName(row),
      sublabel: row.property || undefined,
      run: () => downloadApplicationRow(row),
    }));

  const leaseItems: DownloadItem[] = readLeasePipeline(userId)
    .filter((row) => leaseVisibleToPortalUser(row, userId))
    .filter(leaseHasDownloadableDocument)
    .sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso))
    .map((row) => ({
      id: row.id,
      label: row.residentName || row.residentEmail,
      sublabel: row.unit || undefined,
      run: () => {
        void downloadLeaseFromRow(row);
      },
    }));

  const sections: DownloadSection[] = [];
  if (applicationItems.length > 0) {
    sections.push({ id: "applications", label: "Applications", items: applicationItems });
  }
  if (leaseItems.length > 0) {
    sections.push({ id: "leases", label: "Leases", items: leaseItems });
  }
  return sections;
}

function buildResidentSections(
  email: string,
  userId: string | null,
  residentAxisId: string,
  profileManagerId: string | null = null,
): DownloadSection[] {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return [];

  const demoMode = isDemoModeActive();
  const sections: DownloadSection[] = [];

  const applicationItems: DownloadItem[] = readManagerApplicationRows()
    .filter((row) => (row.email ?? "").trim().toLowerCase() === normalizedEmail)
    .map((row) => ({
      id: row.id,
      label: "Rental application",
      sublabel: row.property || undefined,
      run: () => downloadApplicationRow(row),
    }));
  if (applicationItems.length > 0) {
    sections.push({ id: "application", label: "Application", items: applicationItems });
  }

  const leaseRow = findLeaseForResidentEmail(normalizedEmail, {
    email: normalizedEmail,
    residentAxisId,
    profileManagerId,
  });
  if (leaseRow && hasBothLeaseSignatures(leaseRow)) {
    const leaseName = `Signed lease${leaseRow.unit ? ` · ${leaseRow.unit}` : ""}`;
    sections.push({
      id: "lease",
      label: "Lease",
      items: [
        {
          id: leaseRow.id,
          label: leaseName,
          run: () => {
            downloadLeaseFromRow(leaseRow);
          },
        },
      ],
    });
  }

  const receiptRows = readChargesForResident(normalizedEmail, userId)
    .filter((charge) => charge.status === "paid" && charge.paidAt)
    .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)))
    .map((charge, i) => ({
      id: `${String(charge.paidAt).slice(0, 10)}-${i}`,
      date: String(charge.paidAt).slice(0, 10),
      description: `${charge.title} · ${charge.propertyLabel}`,
      amount: charge.amountLabel,
    }));

  if (receiptRows.length > 0) {
    sections.push({
      id: "receipts",
      label: "Rent receipts",
      items: receiptRows.map((row) => ({
        id: row.id,
        // Named from the payment itself, exactly like Documents › Rent receipts —
        // a utilities or deposit payment must not download labelled as rent (U9).
        label: `${receiptRowLabel(row.description)} · ${row.date}`,
        sublabel: row.amount,
        run: () => downloadReceiptRow(row, demoMode),
      })),
    });
  }

  const uploads = readUploadedOwnLeases(normalizedEmail);
  if (uploads.length > 0) {
    sections.push({
      id: "other",
      label: "Other documents",
      items: uploads.map((row) => ({
        id: row.id,
        label: row.fileName,
        run: () => {
          triggerDocumentDownload(row.dataUrl, row.fileName);
        },
      })),
    });
  }

  return sections;
}

function SectionBlock({
  section,
  selectedIds,
  expanded,
  onToggleExpanded,
  onToggleSection,
  onToggleItem,
}: {
  section: DownloadSection;
  selectedIds: Set<string>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleSection: () => void;
  onToggleItem: (itemId: string) => void;
}) {
  const allSelected = section.items.length > 0 && section.items.every((item) => selectedIds.has(item.id));
  const someSelected = section.items.some((item) => selectedIds.has(item.id));

  return (
    <div className="rounded-2xl border border-border bg-accent/20">
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected;
          }}
          onChange={onToggleSection}
          data-attr={`documents-download-all-section-${section.id}`}
          aria-label={`Include ${section.label}`}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          data-attr={`documents-download-all-section-expand-${section.id}`}
        >
          <span>
            <span className="text-sm font-semibold text-foreground">{section.label}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {section.items.length} document{section.items.length === 1 ? "" : "s"}
            </span>
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>
      {expanded ? (
        <ul className="space-y-2 border-t border-border px-4 py-3">
          {section.items.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border hover:bg-accent/30">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
                  checked={selectedIds.has(item.id)}
                  onChange={() => onToggleItem(item.id)}
                  data-attr={`documents-download-all-item-${section.id}`}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{item.label}</span>
                  {item.sublabel ? <span className="mt-0.5 block truncate text-xs text-muted">{item.sublabel}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DocumentsDownloadAllModal({
  open,
  onClose,
  portal,
  userId,
  residentEmail = "",
  residentUserId = null,
  residentAxisId = "",
  profileManagerId = null,
}: {
  open: boolean;
  onClose: () => void;
  portal: "manager" | "resident";
  userId: string | null;
  residentEmail?: string;
  residentUserId?: string | null;
  residentAxisId?: string;
  profileManagerId?: string | null;
}) {
  const { showToast } = useAppUi();
  const [sections, setSections] = useState<DownloadSection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const runMapRef = useRef(new Map<string, () => void | Promise<void>>());

  const refreshSections = useCallback(() => {
    const next =
      portal === "manager"
        ? buildManagerSections(userId)
        : buildResidentSections(residentEmail, residentUserId, residentAxisId, profileManagerId);
    setSections(next);
    const allIds = new Set(next.flatMap((section) => section.items.map((item) => item.id)));
    setSelectedIds(allIds);
    setExpandedSections(new Set(next.map((section) => section.id)));
    const runMap = new Map<string, () => void | Promise<void>>();
    for (const section of next) {
      for (const item of section.items) {
        runMap.set(item.id, item.run);
      }
    }
    runMapRef.current = runMap;
  }, [portal, userId, residentEmail, residentUserId, residentAxisId, profileManagerId]);

  useEffect(() => {
    if (!open) return;
    if (portal === "manager") {
      void syncManagerApplicationsFromServer().then(() => {
        void syncLeasePipelineFromServer(userId ?? undefined).then(refreshSections);
      });
      return;
    }
    void syncLeasePipelineFromServer().then(refreshSections);
  }, [open, portal, userId, refreshSections]);

  useEffect(() => {
    if (!open || portal !== "manager") return;
    const refresh = () => {
      refreshSections();
    };
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
  }, [open, portal, refreshSections]);

  const selectedCount = useMemo(() => selectedIds.size, [selectedIds]);

  const toggleSection = (section: DownloadSection) => {
    const allSelected = section.items.every((item) => selectedIds.has(item.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const item of section.items) next.delete(item.id);
      } else {
        for (const item of section.items) next.add(item.id);
      }
      return next;
    });
  };

  const toggleItem = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleSectionExpanded = (sectionId: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  const handleDownload = async () => {
    if (selectedCount === 0) {
      showToast("Select at least one document to download.");
      return;
    }
    setDownloading(true);
    let count = 0;
    try {
      for (const id of selectedIds) {
        const run = runMapRef.current.get(id);
        if (!run) continue;
        await run();
        count += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      showToast(count === 1 ? "Downloaded 1 document." : `Downloaded ${count} documents.`);
      onClose();
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Download all"
      onClose={onClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <Button
            type="button"
            className="rounded-full"
            disabled={downloading || selectedCount === 0 || sections.length === 0}
            onClick={() => handleDownload()}
            data-attr="documents-download-all-submit"
          >
            {downloading ? "Downloading…" : `Download${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Choose which document sections and files to download. Your browser may ask to allow multiple downloads.
        </p>

        {sections.length === 0 ? (
          <p className="rounded-xl border border-border bg-accent/20 px-4 py-6 text-center text-sm text-muted">
            No downloadable documents yet.
          </p>
        ) : (
          <div className="max-h-[min(52vh,420px)] space-y-3 overflow-y-auto pr-1">
            {sections.map((section) => (
              <SectionBlock
                key={section.id}
                section={section}
                selectedIds={selectedIds}
                expanded={expandedSections.has(section.id)}
                onToggleExpanded={() => toggleSectionExpanded(section.id)}
                onToggleSection={() => toggleSection(section)}
                onToggleItem={toggleItem}
              />
            ))}
          </div>
        )}

      </div>
    </Modal>
  );
}
