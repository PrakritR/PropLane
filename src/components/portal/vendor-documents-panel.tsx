"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, Clock, FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { DocumentInlineViewer, triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { VendorUploadDocumentWorkspace } from "@/components/portal/vendor-upload-document-workspace";
import { isDemoModeActive, subscribeDemoPath } from "@/lib/demo/demo-session";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import {
  VENDOR_DOCUMENT_LABELS,
  VENDOR_DOCUMENT_SECTIONS,
  VENDOR_DOCUMENT_TABS,
  isVendorComplianceDocumentKind,
  readVendorDocumentDataUrl,
  type VendorDocumentKind,
  type VendorDocumentRecord,
} from "@/lib/vendor-documents";

import { DOCUMENT_CATEGORY_LABELS, type ManagerDocumentDTO } from "@/lib/documents/manager-documents";

const DEMO_VENDOR_DOCUMENTS: VendorDocumentRecord[] = [
  {
    kind: "w9",
    fileName: "cascade-mechanical-w9.pdf",
    url: "/api/vendor/documents/signed-url?kind=w9",
    uploadedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
  },
  {
    kind: "insurance",
    fileName: "general-liability-certificate.pdf",
    url: "/api/vendor/documents/signed-url?kind=insurance",
    uploadedAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
  },
  {
    kind: "license",
    fileName: "wa-contractor-license.pdf",
    url: "/api/vendor/documents/signed-url?kind=license",
    uploadedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
  },
];

type DocumentsPayload = {
  linked?: boolean;
  documents?: VendorDocumentRecord[];
};

type DocumentSource = "all" | "mine" | "managers";

/**
 * One row's ⋯ — mirrors `BookingsRowOverflow` (`bookings-row-overflow.tsx`),
 * the shared way to give a `PortalRecordListSurface` row its own action scope
 * outside a bulk-select list. `RecordActionMenu` adds "View" automatically
 * whenever the wrapped row is given an `onOpen` (and it is omitted via
 * `omitActionView` on the row for a missing document, where there's nothing
 * to view).
 */
function VendorDocumentRowOverflow({
  label,
  hasDoc,
  onReplace,
  onDownload,
  onDelete,
  children,
}: {
  label: string;
  hasDoc: boolean;
  onReplace: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: label,
        clear: () => {},
        actions: (
          <>
            {onDownload ? (
              <Button
                type="button"
                variant="outline"
                data-attr="vendor-document-download"
                data-record-action-id="download"
                onClick={onDownload}
              >
                Download
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              data-attr="vendor-document-replace"
              data-record-action-id="edit"
              onClick={onReplace}
            >
              {hasDoc ? "Replace" : "Upload"}
            </Button>
            {onDelete ? (
              <Button
                type="button"
                variant="danger"
                data-attr="vendor-document-delete"
                data-record-action-id="delete"
                onClick={onDelete}
              >
                Delete
              </Button>
            ) : null}
          </>
        ),
      }}
    >
      {children}
    </RecordActionContext.Provider>
  );
}

/**
 * Vendor Documents — the vendor's own compliance checklist, grouped by
 * section (Tax / Business license / Insurance, 2026-09-27), plus
 * manager-shared files. No status tabs (VD16) — Filter narrows by section.
 */
export function VendorDocumentsPanel({
  basePath = "/vendor",
  demo: demoProp,
}: {
  basePath?: string;
  demo?: boolean;
}) {
  const { showToast } = useAppUi();
  const demoFromPath = useSyncExternalStore(subscribeDemoPath, isDemoModeActive, () => false);
  const demo = demoProp ?? demoFromPath;
  const loadToastShown = useRef(false);
  const sharedLoadToastShown = useRef(false);
  const fileRefs = useRef<Partial<Record<VendorDocumentKind, HTMLInputElement | null>>>({});

  const [documents, setDocuments] = useState<VendorDocumentRecord[]>(() => (demo ? DEMO_VENDOR_DOCUMENTS : []));
  const [loading, setLoading] = useState(!demo);
  const [uploadingKind, setUploadingKind] = useState<VendorDocumentKind | null>(null);
  const [previewKind, setPreviewKind] = useState<VendorDocumentKind | null>(null);
  // Bytes are only ever reached through a server-minted signed URL
  // (docs/agents/documents-module.md), so the previewed doc's own stored `url`
  // marker is never used as an iframe `src` directly — this is fetched fresh
  // from `/api/vendor/documents/signed-url` whenever `previewKind` changes.
  const [ownPreviewUrl, setOwnPreviewUrl] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [source, setSource] = useState<DocumentSource>("all");
  const [category, setCategory] = useState<string>("");
  const [sharedDocuments, setSharedDocuments] = useState<ManagerDocumentDTO[]>([]);
  const [sharedLoading, setSharedLoading] = useState(!demo);
  const [sharedExpandedId, setSharedExpandedId] = useState<string | null>(null);
  const [sharedPreview, setSharedPreview] = useState<{ title: string; url: string } | null>(null);

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

  const loadSharedDocuments = useCallback(async () => {
    if (demo) {
      setSharedDocuments([]);
      setSharedLoading(false);
      return;
    }
    setSharedLoading(true);
    try {
      const res = await fetch("/api/vendor/shared-documents", { credentials: "include" });
      if (res.status === 401 || res.status === 403) {
        setSharedDocuments([]);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { documents?: ManagerDocumentDTO[] };
      if (!res.ok) throw new Error("Failed to load documents from managers.");
      setSharedDocuments(Array.isArray(data.documents) ? data.documents : []);
    } catch (error) {
      if (!sharedLoadToastShown.current) {
        sharedLoadToastShown.current = true;
        showToast(error instanceof Error ? error.message : "Failed to load documents from managers.");
      }
    } finally {
      setSharedLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    void loadSharedDocuments();
  }, [loadSharedDocuments]);

  useEffect(() => {
    setSharedExpandedId(null);
    setPreviewKind(null);
  }, [source, category]);

  useEffect(() => {
    if (!previewKind || demo) {
      setOwnPreviewUrl(null);
      return;
    }
    let cancelled = false;
    setOwnPreviewUrl(null);
    void fetch(`/api/vendor/documents/signed-url?kind=${encodeURIComponent(previewKind)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? "Could not load document preview.");
        if (!cancelled) setOwnPreviewUrl(data.url);
      })
      .catch((e) => {
        if (cancelled) return;
        showToast(e instanceof Error ? e.message : "Could not load document preview.");
        setPreviewKind(null);
      });
    return () => {
      cancelled = true;
    };
  }, [previewKind, demo, showToast]);

  const documentsByKind = useMemo(() => {
    const map = new Map<VendorDocumentKind, VendorDocumentRecord>();
    for (const doc of documents) map.set(doc.kind, doc);
    return map;
  }, [documents]);

  /** The vendor's own checklist rows — every kind, on file or not. */
  const ownRows = useMemo(
    () =>
      VENDOR_DOCUMENT_SECTIONS.flatMap((section) =>
        section.kinds.map((kind) => ({
          kind,
          sectionId: section.id,
          sectionLabel: section.label,
          doc: documentsByKind.get(kind),
        })),
      ),
    [documentsByKind],
  );

  // Source: "mine" keeps only the vendor's own checklist; "managers" keeps
  // only manager-shared files (always on file); "all" keeps both.
  const sourceOwnRows = source === "managers" ? [] : ownRows;
  const sourceSharedRows = source === "mine" ? [] : sharedDocuments;

  // Category (Section) groups the vendor's own three-section checklist —
  // Tax / Business license / Insurance. Manager-shared files use a different,
  // wider category taxonomy of their own (lease/notice/invoice/…) — picking a
  // vendor section narrows to the vendor's own rows rather than guessing an
  // equivalence between the two enums.
  const categoryOwnRows = category ? sourceOwnRows.filter((row) => row.sectionId === category) : sourceOwnRows;
  const categorySharedRows = category ? [] : sourceSharedRows;

  const needle = listSearch.trim().toLowerCase();
  const ownRowsVisible = useMemo(() => {
    if (!needle) return categoryOwnRows;
    return categoryOwnRows.filter((row) => {
      const haystack = `${VENDOR_DOCUMENT_LABELS[row.kind]} ${row.sectionLabel} ${row.doc?.fileName ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [categoryOwnRows, needle]);
  const sharedRowsVisible = useMemo(() => {
    if (!needle) return categorySharedRows;
    return categorySharedRows.filter((doc) =>
      `${doc.displayName} ${DOCUMENT_CATEGORY_LABELS[doc.category]}`.toLowerCase().includes(needle),
    );
  }, [categorySharedRows, needle]);

  // No status tabs any more (VD16) — the checklist renders grouped by
  // section instead, each header showing "uploaded of total" for that
  // section's real kinds (unaffected by search, which only narrows the rows
  // shown underneath). A section with no rows matching the current
  // section/search filters is left out entirely.
  const ownSectionsVisible = useMemo(() => {
    const visibleIds = new Set(ownRowsVisible.map((row) => row.kind));
    return VENDOR_DOCUMENT_SECTIONS.filter((section) => !category || category === section.id)
      .map((section) => {
        const fullRows = sourceOwnRows.filter((row) => row.sectionId === section.id);
        const rows = fullRows.filter((row) => visibleIds.has(row.kind));
        const uploadedCount = fullRows.filter((row) => row.doc).length;
        return { section, rows, uploadedCount, totalCount: fullRows.length };
      })
      .filter((entry) => entry.rows.length > 0);
  }, [category, ownRowsVisible, sourceOwnRows]);

  // First still-missing REQUIRED kind, in section order — the header upload
  // picker's default selection (VD19); falls back to the first missing kind
  // of any kind, then to nothing (every document already on file).
  const defaultUploadKind = useMemo<VendorDocumentKind | undefined>(() => {
    const missing = ownRows.filter((row) => !row.doc);
    return (missing.find((row) => isVendorComplianceDocumentKind(row.kind)) ?? missing[0])?.kind;
  }, [ownRows]);

  const previewDoc = previewKind ? documentsByKind.get(previewKind) : undefined;
  const visibleRowCount = ownRowsVisible.length + sharedRowsVisible.length;
  const includesMine = source !== "managers";

  const uploadFile = async (kind: VendorDocumentKind, file: File) => {
    if (demo) {
      setDocuments((cur) => {
        const next = cur.filter((d) => d.kind !== kind);
        next.push({
          kind,
          fileName: file.name,
          url: `/api/vendor/documents/signed-url?kind=${encodeURIComponent(kind)}`,
          uploadedAt: new Date().toISOString(),
        });
        return next;
      });
      showToast(`${VENDOR_DOCUMENT_LABELS[kind]} saved (demo).`);
      return;
    }
    setUploadingKind(kind);
    try {
      const dataUrl = await readVendorDocumentDataUrl(file);
      const res = await fetch("/api/vendor/documents/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ kind, dataUrl, fileName: file.name }),
      });
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
      showToast("Document removed.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove document.");
    }
  };

  /**
   * Fetch-then-blob rather than a direct anchor to the signed URL (or through
   * a redirect): a download that instead navigates cross-origin opens a new
   * tab in the native WebView instead of downloading (AGENTS.md "Inbox
   * attachments"); this reads the bytes with an ordinary same-origin-initiated
   * `fetch`, so no navigation ever happens.
   */
  const downloadOwnDocument = async (kind: VendorDocumentKind, fallbackFileName: string) => {
    try {
      const res = await fetch(`/api/vendor/documents/signed-url?kind=${encodeURIComponent(kind)}&download=1`, {
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; fileName?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not download document.");
      const fileRes = await fetch(data.url);
      if (!fileRes.ok) throw new Error("Could not download document.");
      const blob = await fileRes.blob();
      const objectUrl = URL.createObjectURL(blob);
      triggerDocumentDownload(objectUrl, data.fileName ?? fallbackFileName);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not download document.");
    }
  };

  const previewSharedDocument = async (doc: ManagerDocumentDTO) => {
    try {
      const response = await fetch(`/api/vendor/shared-documents/${doc.id}/signed-url`, { credentials: "include" });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? "Could not load document preview.");
      setSharedPreview({ title: doc.displayName, url: data.url });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load document preview.");
    }
  };

  // No status tabs (VD16) — the Filter sheet narrows by Source and Section
  // only, never the same dimension twice.
  const filterActiveCount = portalFilterActiveCount([source !== "all" ? source : "", category]);
  const sourceOptions = [
    { value: "all", label: "All" },
    { value: "mine", label: "Mine" },
    { value: "managers", label: "From managers" },
  ];
  const sectionOptions = [
    { value: "", label: "All sections" },
    ...VENDOR_DOCUMENT_TABS.map((tab) => ({ value: tab.id, label: tab.label })),
  ];

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterActiveCount}
      compactPanel
      filterFieldCount={2}
      commandStripTrigger
      onReset={() => {
        setSource("all");
        setCategory("");
      }}
      dataAttr="vendor-documents-filter-open"
    >
      <FilterFieldsAccordion>
        <FilterCollapsibleSection
          sectionId="source"
          label="Source"
          summary={filterSingleSelectSummary(source, sourceOptions, "All")}
          empty={source === "all"}
          menuOptionCount={sourceOptions.length}
          dataAttr="vendor-documents-filter-source"
        >
          <FilterSingleSelectList
            options={sourceOptions}
            value={source}
            onChange={(next) => setSource(next as DocumentSource)}
            dataAttr="vendor-documents-source"
          />
        </FilterCollapsibleSection>
        <FilterCollapsibleSection
          sectionId="section"
          label="Section"
          summary={filterSingleSelectSummary(category, sectionOptions, "All sections")}
          empty={!category}
          menuOptionCount={sectionOptions.length}
          dataAttr="vendor-documents-filter-section"
        >
          <FilterSingleSelectList options={sectionOptions} value={category} onChange={setCategory} dataAttr="vendor-documents-section" />
        </FilterCollapsibleSection>
      </FilterFieldsAccordion>
    </PortalFilterSortSheet>
  );

  return (
    <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search documents",
          dataAttr: "vendor-documents-search",
        }}
        actions={filterSheet}
        primary={
          includesMine ? (
            <PortalPrimaryIconAction
              icon={Upload}
              label={portalListAddPrimaryLabel("document")}
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
      ) : loading || sharedLoading ? (
        <ListSkeleton rows={4} showLeading={false} />
      ) : (
        <PortalRecordListSurface
          isEmpty={visibleRowCount === 0}
          emptyCard={{
            title: listSearch.trim() ? "No documents match this search" : portalEmptyCopy("documents.other").title,
            section: portalEmptyCopy("documents.other").section,
            tone: listSearch.trim() ? "muted" : "default",
            actions: listSearch.trim() || !includesMine
              ? []
              : [{ label: portalListAddPrimaryLabel("document"), onClick: () => setUploadOpen(true), dataAttr: "vendor-documents-empty-add" }],
            clear: listSearch.trim()
              ? {
                  label: "Clear search",
                  onClick: () => setListSearch(""),
                  dataAttr: "vendor-documents-empty-clear-search",
                }
              : undefined,
          }}
          add={
            includesMine
              ? {
                  ariaLabel: "Upload document",
                  onClick: () => setUploadOpen(true),
                  dataAttr: "vendor-documents-list-add",
                }
              : undefined
          }
          dataAttr="vendor-documents-list"
        >
          {ownSectionsVisible.map(({ section, rows, uploadedCount, totalCount }) => (
            <div key={section.id} data-attr="vendor-documents-section" className="vdoc-section">
              <div className="flex items-baseline justify-between px-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                <span>{section.label}</span>
                <span className="font-semibold normal-case tracking-normal text-[12.5px]">
                  {uploadedCount} of {totalCount}
                </span>
              </div>
              {rows.map(({ kind, doc }) => {
                const complianceMissing = !doc && isVendorComplianceDocumentKind(kind);
                return (
                  <VendorDocumentRowOverflow
                    key={kind}
                    label={VENDOR_DOCUMENT_LABELS[kind]}
                    hasDoc={Boolean(doc)}
                    onReplace={() => fileRefs.current[kind]?.click()}
                    onDownload={doc ? () => void downloadOwnDocument(kind, doc.fileName) : undefined}
                    onDelete={doc ? () => removeDocument(kind) : undefined}
                  >
                    <PortalPropertyRecordRow
                      title={VENDOR_DOCUMENT_LABELS[kind]}
                      attention={complianceMissing}
                      address={doc?.fileName}
                      leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                      // Uploaded shows the date; a required-but-missing kind
                      // reads "Required" with an alert glyph, an optional
                      // missing kind reads "Not uploaded" with a clock glyph
                      // — never the old on-file/missing tab wording (VD18).
                      facts={
                        doc ? (
                          <PortalRowFact icon={Check} srLabel="Uploaded">
                            {`Uploaded ${safeFormatDateTime(doc.uploadedAt)}`}
                          </PortalRowFact>
                        ) : complianceMissing ? (
                          <PortalRowFact icon={AlertTriangle} srLabel="Required">
                            Required
                          </PortalRowFact>
                        ) : (
                          <PortalRowFact icon={Clock} srLabel="Not uploaded">
                            Not uploaded
                          </PortalRowFact>
                        )
                      }
                      omitActionView={!doc}
                      onOpen={doc ? () => setPreviewKind((cur) => (cur === kind ? null : kind)) : () => fileRefs.current[kind]?.click()}
                      dataAttr="vendor-document-row"
                    />
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
                      data-attr={`vendor-documents-upload-input-${kind}`}
                    />
                    {uploadingKind === kind ? <p className="px-1 text-xs text-muted">Uploading…</p> : null}
                  </VendorDocumentRowOverflow>
                );
              })}
            </div>
          ))}
          {sharedRowsVisible.map((doc) => {
            const expanded = sharedExpandedId === doc.id;
            return (
              <div key={doc.id}>
                <PortalPropertyRecordRow
                  title={doc.displayName}
                  address={DOCUMENT_CATEGORY_LABELS[doc.category]}
                  leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                  facts={safeFormatDateTime(doc.createdAt)}
                  selected={expanded}
                  onOpen={() => {
                    setSharedExpandedId((current) => (current === doc.id ? null : doc.id));
                    void previewSharedDocument(doc);
                  }}
                  dataAttr="vendor-document-row"
                />
              </div>
            );
          })}
        </PortalRecordListSurface>
      )}

      {previewDoc && previewKind ? (
        <DocumentInlineViewer
          title={VENDOR_DOCUMENT_LABELS[previewKind]}
          src={demo ? null : ownPreviewUrl}
          onDownload={() => {
            if (demo) {
              showToast("PDF preview is available on a live vendor account.");
              return;
            }
            void downloadOwnDocument(previewKind, previewDoc.fileName);
          }}
          downloadLabel="Download PDF"
          downloadAttr={`vendor-documents-inline-download-${previewKind}`}
        />
      ) : null}
      {sharedPreview ? (
        <DocumentInlineViewer
          title={sharedPreview.title}
          src={sharedPreview.url}
          onDownload={() => triggerDocumentDownload(sharedPreview.url, sharedPreview.title)}
          downloadLabel="Download"
          downloadAttr="vendor-shared-document-inline-download"
        />
      ) : null}

      <VendorUploadDocumentWorkspace
        open={uploadOpen}
        demo={demo}
        initialKind={defaultUploadKind}
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
