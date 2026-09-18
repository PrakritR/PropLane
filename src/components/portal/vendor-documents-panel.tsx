"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowStatusChip } from "@/components/portal/portal-record-row";
import {
  PORTAL_DETAIL_BTN,
  PORTAL_DETAIL_BTN_PRIMARY,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { DocumentInlineViewer, triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { PortalSharedDocumentsTable } from "@/components/portal/portal-shared-documents-table";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { VendorUploadDocumentWorkspace } from "@/components/portal/vendor-upload-document-workspace";
import { isDemoModeActive, subscribeDemoPath } from "@/lib/demo/demo-session";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import {
  VENDOR_DOCUMENT_LABELS,
  VENDOR_DOCUMENT_SECTIONS,
  vendorDocumentStatusLabel,
  type VendorDocumentKind,
  type VendorDocumentRecord,
} from "@/lib/vendor-documents";

const DEMO_VENDOR_DOCUMENTS: VendorDocumentRecord[] = [
  {
    kind: "w9",
    fileName: "cascade-mechanical-w9.pdf",
    url: "/api/vendor/documents/file?kind=w9",
    uploadedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
  },
  {
    kind: "insurance",
    fileName: "general-liability-certificate.pdf",
    url: "/api/vendor/documents/file?kind=insurance",
    uploadedAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
  },
  {
    kind: "license",
    fileName: "wa-contractor-license.pdf",
    url: "/api/vendor/documents/file?kind=license",
    uploadedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
  },
];

type DocumentsPayload = {
  linked?: boolean;
  documents?: VendorDocumentRecord[];
};

function statusChipTone(doc: VendorDocumentRecord | undefined): "ok" | "warn" | "neutral" {
  const label = vendorDocumentStatusLabel(doc).toLowerCase();
  if (label.includes("on file") || label.includes("uploaded")) return "ok";
  if (label.includes("expir") || label.includes("missing")) return "warn";
  return "neutral";
}

/** Vendor Documents — Mine / From managers command bar + upload workspace. */
export function VendorDocumentsPanel({
  tabId,
  basePath = "/vendor",
  demo: demoProp,
}: {
  tabId: string;
  basePath?: string;
  demo?: boolean;
}) {
  const { showToast } = useAppUi();
  const demoFromPath = useSyncExternalStore(subscribeDemoPath, isDemoModeActive, () => false);
  const demo = demoProp ?? demoFromPath;
  const loadToastShown = useRef(false);
  const fileRefs = useRef<Partial<Record<VendorDocumentKind, HTMLInputElement | null>>>({});

  const [documents, setDocuments] = useState<VendorDocumentRecord[]>(() => (demo ? DEMO_VENDOR_DOCUMENTS : []));
  const [loading, setLoading] = useState(!demo);
  const [uploadingKind, setUploadingKind] = useState<VendorDocumentKind | null>(null);
  const [previewKind, setPreviewKind] = useState<VendorDocumentKind | null>(null);
  const [expandedKind, setExpandedKind] = useState<VendorDocumentKind | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");

  const tabItems = useMemo(
    () => [
      { id: "mine", label: "Mine", href: `${basePath}/documents/mine` },
      { id: "shared", label: "From managers", href: `${basePath}/documents/shared` },
    ],
    [basePath],
  );

  const loadDocuments = useCallback(async () => {
    if (demo) {
      setDocuments(DEMO_VENDOR_DOCUMENTS);
      setLoading(false);
      setAccessDenied(false);
      return;
    }
    setLoading(true);
    setAccessDenied(false);
    try {
      const res = await fetch("/api/vendor/documents", { credentials: "include" });
      const data = (await res.json()) as DocumentsPayload & { error?: string };
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setDocuments([]);
          setAccessDenied(true);
          return;
        }
        throw new Error(data.error ?? "Failed to load documents.");
      }
      setUnlinked(data.linked === false);
      setDocuments(data.documents ?? []);
    } catch (e) {
      if (!loadToastShown.current) {
        loadToastShown.current = true;
        showToast(e instanceof Error ? e.message : "Failed to load documents.");
      }
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    setExpandedKind(null);
    setPreviewKind(null);
    setListSearch("");
  }, [tabId]);

  const documentsByKind = useMemo(() => {
    const map = new Map<VendorDocumentKind, VendorDocumentRecord>();
    for (const doc of documents) map.set(doc.kind, doc);
    return map;
  }, [documents]);

  const rows = useMemo(() => {
    if (tabId === "shared") return [];
    const needle = listSearch.trim().toLowerCase();
    return VENDOR_DOCUMENT_SECTIONS.flatMap((section) =>
      section.kinds.map((kind) => ({
        kind,
        section: section.label,
        doc: documentsByKind.get(kind),
      })),
    ).filter((row) => {
      if (!needle) return true;
      const haystack = `${VENDOR_DOCUMENT_LABELS[row.kind]} ${row.section} ${row.doc?.fileName ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [tabId, documentsByKind, listSearch]);

  const previewDoc = previewKind ? documentsByKind.get(previewKind) : undefined;

  const uploadFile = async (kind: VendorDocumentKind, file: File) => {
    if (demo) {
      setDocuments((cur) => {
        const next = cur.filter((d) => d.kind !== kind);
        next.push({
          kind,
          fileName: file.name,
          url: `/api/vendor/documents/file?kind=${encodeURIComponent(kind)}`,
          uploadedAt: new Date().toISOString(),
        });
        return next;
      });
      showToast(`${VENDOR_DOCUMENT_LABELS[kind]} saved (demo).`);
      return;
    }
    setUploadingKind(kind);
    try {
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file);
      const res = await fetch("/api/vendor/documents/upload", { method: "POST", credentials: "include", body });
      const data = (await res.json()) as { documents?: VendorDocumentRecord[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setDocuments(data.documents ?? []);
      showToast(`${VENDOR_DOCUMENT_LABELS[kind]} uploaded.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploadingKind(null);
    }
  };

  const removeDocument = async (kind: VendorDocumentKind) => {
    if (demo) {
      setDocuments((cur) => cur.filter((d) => d.kind !== kind));
      if (previewKind === kind) setPreviewKind(null);
      if (expandedKind === kind) setExpandedKind(null);
      showToast("Document removed (demo).");
      return;
    }
    try {
      const res = await fetch("/api/vendor/documents", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeKind: kind }),
      });
      const data = (await res.json()) as { documents?: VendorDocumentRecord[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not remove document.");
      setDocuments(data.documents ?? []);
      if (previewKind === kind) setPreviewKind(null);
      if (expandedKind === kind) setExpandedKind(null);
      showToast("Document removed.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove document.");
    }
  };

  const renderRowActions = (kind: VendorDocumentKind, doc: VendorDocumentRecord | undefined) => {
    const busy = uploadingKind === kind;
    return (
      <PortalTableDetailActions>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN_PRIMARY}
          disabled={busy}
          data-attr={`vendor-documents-upload-${kind}`}
          onClick={() => fileRefs.current[kind]?.click()}
        >
          {busy ? "Uploading…" : doc ? "Replace PDF" : "Upload PDF"}
        </Button>
        {doc ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr={`vendor-documents-view-${kind}`}
              onClick={() => setPreviewKind((cur) => (cur === kind ? null : kind))}
            >
              {previewKind === kind ? "Hide preview" : "View"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr={`vendor-documents-download-${kind}`}
              onClick={() => {
                if (demo) {
                  showToast("Download is available after you sign in to a live vendor account.");
                  return;
                }
                triggerDocumentDownload(doc.url, doc.fileName);
              }}
            >
              Download
            </Button>
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_DETAIL_BTN} text-danger`}
              data-attr={`vendor-documents-remove-${kind}`}
              onClick={() => removeDocument(kind)}
            >
              Remove
            </Button>
          </>
        ) : null}
        <input
          ref={(el) => {
            fileRefs.current[kind] = el;
          }}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void uploadFile(kind, file);
          }}
        />
      </PortalTableDetailActions>
    );
  };

  return (
    <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={tabItems.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: tab.href,
          dataAttr: `vendor-documents-tab-${tab.id}`,
        }))}
        activeDestinationId={tabId}
        destinationAriaLabel="Document views"
        search={
          tabId === "mine"
            ? {
                value: listSearch,
                onChange: setListSearch,
                placeholder: "Search documents",
                dataAttr: "vendor-documents-search",
              }
            : undefined
        }
        primary={
          tabId === "mine" ? (
            <PortalPrimaryIconAction
              label="Upload"
              data-attr="vendor-documents-add"
              onClick={() => setUploadOpen(true)}
            />
          ) : undefined
        }
      />

      {accessDenied ? (
        <PortalListEmptyCard
          title="Sign in as a vendor"
          section="documents"
          dataAttr="vendor-documents-access-denied-banner"
        />
      ) : tabId === "shared" ? (
        <PortalSharedDocumentsTable
          listUrl="/api/vendor/shared-documents"
          signedUrlBase="/api/vendor/shared-documents"
          emptyMessage="No documents shared with you yet."
          demoMessage="Documents from managers appear here after they share files from their library."
          demo={demo}
        />
      ) : loading ? (
        <p className="text-sm font-semibold text-foreground">Loading documents…</p>
      ) : (
        <PortalRecordListSurface
          isEmpty={rows.length === 0}
          emptyCard={{
            title: listSearch.trim() ? "No documents match this search" : portalEmptyCopy("documents.other").title,
            section: portalEmptyCopy("documents.other").section,
            tone: listSearch.trim() ? "muted" : "default",
            actions: listSearch.trim()
              ? []
              : [{ label: "Upload", onClick: () => setUploadOpen(true), dataAttr: "vendor-documents-empty-add" }],
            clear: listSearch.trim()
              ? {
                  label: "Clear search",
                  onClick: () => setListSearch(""),
                  dataAttr: "vendor-documents-empty-clear-search",
                }
              : undefined,
          }}
          add={{
            ariaLabel: "Upload document",
            onClick: () => setUploadOpen(true),
            dataAttr: "vendor-documents-list-add",
          }}
          dataAttr="vendor-documents-list"
        >
          {unlinked ? (
            <PortalListEmptyCard
              title="Waiting on a manager"
              section="documents"
              tone="muted"
              dataAttr="vendor-documents-unlinked-banner"
            />
          ) : null}
          {rows.map(({ kind, section, doc }) => {
            const expanded = expandedKind === kind;
            return (
              <div key={kind}>
                <PortalPropertyRecordRow
                  title={VENDOR_DOCUMENT_LABELS[kind]}
                  address={doc?.fileName ?? section}
                  leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                  facts={doc ? safeFormatDateTime(doc.uploadedAt) : undefined}
                  chip={
                    <PortalRowStatusChip tone={statusChipTone(doc)}>
                      {vendorDocumentStatusLabel(doc)}
                    </PortalRowStatusChip>
                  }
                  selected={expanded}
                  onOpen={() => setExpandedKind((cur) => (cur === kind ? null : kind))}
                  dataAttr="vendor-document-row"
                />
                {expanded ? <div className="mb-2 px-1">{renderRowActions(kind, doc)}</div> : null}
              </div>
            );
          })}
        </PortalRecordListSurface>
      )}

      {previewDoc && previewKind ? (
        <DocumentInlineViewer
          title={VENDOR_DOCUMENT_LABELS[previewKind]}
          src={demo ? null : previewDoc.url}
          onDownload={() => {
            if (demo) {
              showToast("PDF preview is available on a live vendor account.");
              return;
            }
            triggerDocumentDownload(previewDoc.url, previewDoc.fileName);
          }}
          downloadLabel="Download PDF"
          downloadAttr={`vendor-documents-inline-download-${previewKind}`}
        />
      ) : null}

      <VendorUploadDocumentWorkspace
        open={uploadOpen}
        demo={demo}
        onClose={() => setUploadOpen(false)}
        onUploaded={(next) => {
          if (demo) {
            setDocuments((cur) => {
              const kinds = new Set(next.map((doc) => doc.kind));
              return [...cur.filter((doc) => !kinds.has(doc.kind)), ...next];
            });
            return;
          }
          setDocuments(next);
        }}
      />
    </ManagerPortalPageShell>
  );
}
