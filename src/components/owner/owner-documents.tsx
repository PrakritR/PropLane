"use client";

import { CalendarDays, FileText, HardDrive } from "lucide-react";
import { useMemo, useState } from "react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { formatPacificDate } from "@/lib/pacific-time";
import type { OwnerDocumentRow } from "@/lib/property-owner/projection";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Documents — only what the manager shared with owners, bytes via a signed URL. */
export function OwnerDocumentsPage() {
  const { showToast } = useAppUi();
  const { data, loading, error, reload } = useOwnerFetch<{ documents: OwnerDocumentRow[] }>("/api/owner/documents");
  const [query, setQuery] = useState("");
  const documents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.documents ?? []).filter((doc) => !q || doc.title.toLowerCase().includes(q));
  }, [data, query]);

  const open = async (doc: OwnerDocumentRow) => {
    try {
      const res = await fetch(`/api/owner/documents/${encodeURIComponent(doc.id)}/signed-url?download=1`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Could not open this document.");
      window.location.assign(body.url);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not open this document.");
    }
  };

  return (
    <div data-attr="owner-documents" className="space-y-2">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={[{ id: "shared", label: "Shared with you", count: data?.documents.length, dataAttr: "owner-documents-tab-shared" }]}
            activeId="shared"
            onChange={() => undefined}
            ariaLabel="Documents"
            appearance="command"
          />
        }
        activeDestinationId="shared"
        destinationAriaLabel="Documents"
        search={{ value: query, onChange: setQuery, placeholder: "Search documents", ariaLabel: "Search documents", dataAttr: "owner-documents-search" }}
      />
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message="Couldn't load your documents." onRetry={reload} />
      ) : (
        <PortalRecordListSurface
          dataAttr="owner-documents-list"
          isEmpty={documents.length === 0}
          emptyCard={{ title: query ? "No matching documents" : "No documents yet", section: "documents" }}
        >
          {documents.map((doc) => (
            <PortalPropertyRecordRow
              key={doc.id}
              title={doc.title}
              leading={<PortalRowIconTile icon={FileText} />}
              leadingShape="square"
              facts={
                <>
                  <PortalRowFact icon={HardDrive} srLabel="Size">
                    {doc.mimeType === "application/pdf" ? "PDF" : "File"} · {formatBytes(doc.sizeBytes)}
                  </PortalRowFact>
                  <PortalRowFact icon={CalendarDays} srLabel="Added">
                    {formatPacificDate(doc.createdAt, { month: "short", day: "numeric", year: "numeric" })}
                  </PortalRowFact>
                </>
              }
              onOpen={() => void open(doc)}
              actions={<RowActionsMenu label={doc.title} items={[{ id: "download", label: "Download", onSelect: () => void open(doc), dataAttr: `owner-document-download-${doc.id}` }]} />}
              dataAttr={`owner-document-row-${doc.id}`}
            />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}
