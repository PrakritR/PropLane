"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PORTAL_DETAIL_BTN,
  PORTAL_DETAIL_BTN_PRIMARY,
  PortalDataTableEmpty,
  PortalTableDetailActions,
  PortalTableInlineExpand,
} from "@/components/portal/portal-data-table";
import { DocumentInlineViewer, triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { PortalSharedDocumentsTable } from "@/components/portal/portal-shared-documents-table";
import { isDemoModeActive, subscribeDemoPath } from "@/lib/demo/demo-session";
import { safeFormatDateTime } from "@/lib/pacific-time";
import {
  VENDOR_DOCUMENT_HINTS,
  VENDOR_DOCUMENT_LABELS,
  VENDOR_DOCUMENT_SECTIONS,
  vendorDocumentStatusLabel,
  vendorDocumentStatusTone,
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

/** Vendor Documents — compliance PDFs in manager-style tabs + table layout. */
export function VendorDocumentsPanel({
  tabId,
  basePath = "/vendor",
  demo: demoProp,
}: {
  tabId: string;
  basePath?: string;
  /** When true, skip live API reads/writes and use seeded demo documents. */
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
  }, [tabId]);

  const documentsByKind = useMemo(() => {
    const map = new Map<VendorDocumentKind, VendorDocumentRecord>();
    for (const doc of documents) map.set(doc.kind, doc);
    return map;
  }, [documents]);

  /**
   * Every document a vendor keeps, in one list.
   *
   * Tax & income / Insurance / Business & licensing used to be three tabs, so a
   * vendor had to know which one a file belonged in before uploading it — and
   * a missing certificate was invisible from the other two. The category is a
   * line on the row now. The document KIND is untouched: it is what the upload
   * and remove routes key on, so nothing structural moved.
   */
  const rows = useMemo(() => {
    if (tabId === "shared") return [];
    return VENDOR_DOCUMENT_SECTIONS.flatMap((section) =>
      section.kinds.map((kind) => ({
        kind,
        section: section.label,
        doc: documentsByKind.get(kind),
      })),
    );
  }, [tabId, documentsByKind]);

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
    <ManagerPortalPageShell
      title="Documents"
      hideTitleOnMobileNav
      filterRow={
        <ManagerPortalFilterRow>
          <TabNav items={tabItems} activeId={tabId} />
        </ManagerPortalFilterRow>
      }
    >
      {accessDenied ? (
        <p
          className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-pending"
          data-attr="vendor-documents-access-denied-banner"
        >
          Sign in with a vendor account to upload and manage compliance documents here.
        </p>
      ) : null}

      {unlinked ? (
        <p
          className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-pending"
          data-attr="vendor-documents-unlinked-banner"
        >
          Waiting on a property manager to connect with you. Upload documents here so managers can review your
          compliance files.
        </p>
      ) : null}

      {tabId === "shared" ? (
        <PortalSharedDocumentsTable
          listUrl="/api/vendor/shared-documents"
          signedUrlBase="/api/vendor/shared-documents"
          emptyMessage="No documents shared with you yet."
          demoMessage="Documents from managers appear here after they share files from their library."
          demo={demo}
        />
      ) : loading ? (
        <p className="text-sm text-muted">Loading documents…</p>
      ) : rows.length === 0 ? (
        <PortalDataTableEmpty message="No documents yet." icon="document" />
      ) : (
        <>
          {/*
            One list at every width, in the house shape. This tab used to render
            a mobile card list AND a desktop table over the same rows, so the two
            drifted and neither matched the rest of the product. The row expands
            in place because its actions are uploads, not a detail page.
          */}
          <div className={PORTAL_LIST_PAGE_BODY}>
            {rows.map(({ kind, section, doc }) => {
              const expanded = expandedKind === kind;
              const statusLabel = vendorDocumentStatusLabel(doc);
              return (
                <div
                  key={kind}
                  className={`portal-property-row border-b border-border/50 px-3 py-3 transition-colors max-md:px-2.5 max-md:py-2.5 ${
                    expanded
                      ? "border-l-[3px] border-l-primary bg-primary/[0.06]"
                      : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
                  }`}
                >
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-start gap-3 text-left"
                    onClick={() => setExpandedKind((cur) => (cur === kind ? null : kind))}
                    aria-expanded={expanded}
                    data-attr="vendor-document-row"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <PortalTableInlineExpand
                        expanded={expanded}
                        className="text-sm font-semibold text-foreground"
                      >
                        <span className="truncate">{VENDOR_DOCUMENT_LABELS[kind]}</span>
                      </PortalTableInlineExpand>
                      <p className="text-xs leading-relaxed text-muted">
                        {section} · {doc ? doc.fileName : "No file on file"}
                      </p>
                      {doc ? (
                        <p className="text-xs text-muted">Uploaded {safeFormatDateTime(doc.uploadedAt)}</p>
                      ) : null}
                    </div>
                    <span
                      className={`mt-0.5 inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${vendorDocumentStatusTone(doc)}`}
                    >
                      {statusLabel}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="mb-3 text-xs text-muted">{VENDOR_DOCUMENT_HINTS[kind]}</p>
                      {renderRowActions(kind, doc)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

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
            >
              {demo ? (
                <div className="flex h-64 items-center justify-center px-4 text-center text-sm text-muted">
                  Sample PDFs are listed above in the demo. Sign in to a live vendor account to upload and preview real
                  files.
                </div>
              ) : null}
            </DocumentInlineViewer>
          ) : null}
        </>
      )}
    </ManagerPortalPageShell>
  );
}
