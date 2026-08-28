"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
  MANAGER_TABLE_TH,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DETAIL_BTN,
  PORTAL_DETAIL_BTN_PRIMARY,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR_EXPANDABLE,
  PortalDataTableEmpty,
  PortalTableDetailActions,
  PortalTableExpandChevron,
  PortalTableInlineExpand,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { DocumentInlineViewer, triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { PortalSharedDocumentsTable } from "@/components/portal/portal-shared-documents-table";
import { isDemoModeActive, subscribeDemoPath } from "@/lib/demo/demo-session";
import { safeFormatDateTime } from "@/lib/pacific-time";
import {
  VENDOR_DOCUMENT_HINTS,
  VENDOR_DOCUMENT_LABELS,
  VENDOR_DOCUMENT_TABS,
  vendorDocumentSectionForTab,
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
      ...VENDOR_DOCUMENT_TABS.map((tab) => ({ id: tab.id, label: tab.label, href: `${basePath}/documents/${tab.id}` })),
      { id: "shared", label: "From managers", href: `${basePath}/documents/shared` },
    ],
    [basePath],
  );

  const activeSection = tabId === "shared" ? null : vendorDocumentSectionForTab(tabId) ?? vendorDocumentSectionForTab("tax");

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

  const rows = useMemo(() => {
    if (!activeSection) return [];
    return activeSection.kinds.map((kind) => ({
      kind,
      doc: documentsByKind.get(kind),
    }));
  }, [activeSection, documentsByKind]);

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
        <PortalDataTableEmpty message="No document types in this tab yet." icon="document" />
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {rows.map(({ kind, doc }) => {
              const expanded = expandedKind === kind;
              const statusLabel = vendorDocumentStatusLabel(doc);
              return (
                <div key={kind} className={PORTAL_MOBILE_CARD_CLASS}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-left"
                    onClick={() => setExpandedKind((cur) => (cur === kind ? null : kind))}
                    aria-expanded={expanded}
                  >
                    <div className="flex min-w-0 flex-1 items-start justify-between gap-2.5">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">{VENDOR_DOCUMENT_LABELS[kind]}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {doc ? doc.fileName : "No file on file"}
                        </p>
                      </div>
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${vendorDocumentStatusTone(doc)}`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <PortalTableExpandChevron expanded={expanded} />
                  </button>
                  {expanded ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="mb-3 text-xs text-muted">{VENDOR_DOCUMENT_HINTS[kind]}</p>
                      {doc ? (
                        <p className="mb-3 text-xs text-muted">
                          Uploaded {safeFormatDateTime(doc.uploadedAt)}
                        </p>
                      ) : null}
                      {renderRowActions(kind, doc)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Document</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>File</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ kind, doc }) => {
                    const statusLabel = vendorDocumentStatusLabel(doc);
                    const expanded = expandedKind === kind;
                    return (
                      <Fragment key={kind}>
                        <tr
                          className={PORTAL_TABLE_TR_EXPANDABLE}
                          aria-expanded={expanded}
                          onClick={createPortalRowExpandClick(() =>
                            setExpandedKind((cur) => (cur === kind ? null : kind)),
                          )}
                        >
                          <td className={`${PORTAL_TABLE_TD} align-middle`}>
                            <PortalTableInlineExpand expanded={expanded} className="font-medium text-foreground">
                              {VENDOR_DOCUMENT_LABELS[kind]}
                            </PortalTableInlineExpand>
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{VENDOR_DOCUMENT_HINTS[kind]}</p>
                          </td>
                          <td className={`${PORTAL_TABLE_TD} align-middle`}>
                            <span
                              className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${vendorDocumentStatusTone(doc)}`}
                            >
                              {statusLabel}
                            </span>
                          </td>
                          <td className={`${PORTAL_TABLE_TD} align-middle`}>
                            {doc ? (
                              <>
                                <p className="truncate font-medium text-foreground">{doc.fileName}</p>
                                <p className="mt-0.5 text-xs text-muted">
                                  Uploaded {safeFormatDateTime(doc.uploadedAt)}
                                </p>
                              </>
                            ) : (
                              <p className="text-muted">No file on file</p>
                            )}
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className={PORTAL_TABLE_DETAIL_ROW}>
                            <td colSpan={3} className={PORTAL_TABLE_DETAIL_CELL}>
                              {renderRowActions(kind, doc)}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
