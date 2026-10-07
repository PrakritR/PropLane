"use client";

import { Download, FileText } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerEmpty, OwnerError, OwnerLoading, OwnerPageTitle } from "@/components/owner/owner-ui";
import type { OwnerDocumentRow } from "@/lib/property-owner/projection";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Screen 6: Documents — only what the manager shared with owners, bytes via a signed URL. */
export function OwnerDocumentsPage() {
  const { showToast } = useAppUi();
  const { data, loading, error, reload } = useOwnerFetch<{ documents: OwnerDocumentRow[] }>("/api/owner/documents");

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
    <div data-attr="owner-documents">
      <OwnerPageTitle>Documents</OwnerPageTitle>
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message="Couldn't load your documents." onRetry={reload} />
      ) : !data || data.documents.length === 0 ? (
        <OwnerEmpty title="No documents yet" />
      ) : (
        <PortalRecordListSurface dataAttr="owner-documents-list">
          {data.documents.map((doc) => (
            <PortalServiceRecordRow
              key={doc.id}
              title={doc.title}
              useServiceTile={false}
              leading={
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                  <FileText className="size-5" />
                </span>
              }
              facts={
                <span>
                  {doc.mimeType === "application/pdf" ? "PDF" : "File"} · {formatBytes(doc.sizeBytes)} ·{" "}
                  {new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              }
              onOpen={() => void open(doc)}
              actions={<PortalIconAction icon={Download} label="Download" data-attr={`owner-document-download-${doc.id}`} onClick={() => void open(doc)} />}
              dataAttr={`owner-document-row-${doc.id}`}
            />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}
