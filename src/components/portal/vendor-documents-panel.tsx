"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
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
type DocumentStatusTab = "all" | "on-file" | "missing";

const STATUS_TAB_LABELS: Record<DocumentStatusTab, string> = {
  all: "All",
  "on-file": "On file",
  missing: "Missing",
};

const DOCUMENT_STATUS_TABS: DocumentStatusTab[] = ["all", "on-file", "missing"];

function parseDocumentStatusTab(raw: string): DocumentStatusTab {
  return (DOCUMENT_STATUS_TABS as readonly string[]).includes(raw) ? (raw as DocumentStatusTab) : "all";
}

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
  onDelete,
  children,
}: {
  label: string;
  hasDoc: boolean;
  onReplace: () => void;
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

/** Vendor Documents — one filtered, tabbed list of the vendor's own compliance checklist plus manager-shared files. */
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
  const [unlinked, setUnlinked] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [source, setSource] = useState<DocumentSource>("all");
  const [category, setCategory] = useState<string>("");
  const statusTab = parseDocumentStatusTab(tabId);
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
  }, [source, category, statusTab]);

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

  // Category groups the vendor's own three-section checklist (Tax & income /
  // Insurance / Business & licensing). Manager-shared files use a different,
  // wider category taxonomy of their own (lease/notice/invoice/…) — picking a
  // vendor category narrows to the vendor's own rows rather than guessing an
  // equivalence between the two enums.
  const categoryOwnRows = category ? sourceOwnRows.filter((row) => row.sectionId === category) : sourceOwnRows;
  const categorySharedRows = category ? [] : sourceSharedRows;

  const statusOwnRows = useMemo(() => {
    if (statusTab === "on-file") return categoryOwnRows.filter((row) => Boolean(row.doc));
    if (statusTab === "missing") return categoryOwnRows.filter((row) => !row.doc);
    return categoryOwnRows;
  }, [categoryOwnRows, statusTab]);
  // Manager-shared files are always on file — the "Missing" tab never shows any.
  const statusSharedRows = statusTab === "missing" ? [] : categorySharedRows;

  const needle = listSearch.trim().toLowerCase();
  const ownRowsVisible = useMemo(() => {
    if (!needle) return statusOwnRows;
    return statusOwnRows.filter((row) => {
      const haystack = `${VENDOR_DOCUMENT_LABELS[row.kind]} ${row.sectionLabel} ${row.doc?.fileName ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [statusOwnRows, needle]);
  const sharedRowsVisible = useMemo(() => {
    if (!needle) return statusSharedRows;
    return statusSharedRows.filter((doc) =>
      `${doc.displayName} ${DOCUMENT_CATEGORY_LABELS[doc.category]}`.toLowerCase().includes(needle),
    );
  }, [statusSharedRows, needle]);

  // Tab counts reflect Source + Category (a real narrowing), never the search
  // text (tab counts stay the bucket totals).
  const tabCounts = useMemo(() => {
    const withStatus = (tab: DocumentStatusTab) => {
      const own =
        tab === "on-file"
          ? categoryOwnRows.filter((row) => row.doc)
          : tab === "missing"
            ? categoryOwnRows.filter((row) => !row.doc)
            : categoryOwnRows;
      const shared = tab === "missing" ? [] : categorySharedRows;
      return own.length + shared.length;
    };
    return { all: withStatus("all"), "on-file": withStatus("on-file"), missing: withStatus("missing") };
  }, [categoryOwnRows, categorySharedRows]);

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

  // Status lives on the routed tab (with real counts) — the Filter sheet
  // narrows by Source and Category only, never the same dimension twice.
  const filterActiveCount = portalFilterActiveCount([source !== "all" ? source : "", category]);
  const sourceOptions = [
    { value: "all", label: "All" },
    { value: "mine", label: "Mine" },
    { value: "managers", label: "From managers" },
  ];
  const categoryOptions = [
    { value: "", label: "All categories" },
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
          sectionId="category"
          label="Category"
          summary={filterSingleSelectSummary(category, categoryOptions, "All categories")}
          empty={!category}
          menuOptionCount={categoryOptions.length}
          dataAttr="vendor-documents-filter-category"
        >
          <FilterSingleSelectList options={categoryOptions} value={category} onChange={setCategory} dataAttr="vendor-documents-category" />
        </FilterCollapsibleSection>
      </FilterFieldsAccordion>
    </PortalFilterSortSheet>
  );

  return (
    <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={DOCUMENT_STATUS_TABS.map((id) => ({
          id,
          label: STATUS_TAB_LABELS[id],
          count: tabCounts[id],
          href: `${basePath}/documents/${id}`,
          dataAttr: `vendor-documents-tab-${id}`,
        }))}
        activeDestinationId={statusTab}
        destinationAriaLabel="Document status"
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
          {unlinked ? (
            <PortalListEmptyCard
              title="Waiting on a manager"
              section="documents"
              tone="muted"
              dataAttr="vendor-documents-unlinked-banner"
            />
          ) : null}
          {ownRowsVisible.map(({ kind, sectionLabel, doc }) => {
            const complianceMissing = !doc && isVendorComplianceDocumentKind(kind);
            return (
              <VendorDocumentRowOverflow
                key={kind}
                label={VENDOR_DOCUMENT_LABELS[kind]}
                hasDoc={Boolean(doc)}
                onReplace={() => fileRefs.current[kind]?.click()}
                onDelete={doc ? () => removeDocument(kind) : undefined}
              >
                <PortalPropertyRecordRow
                  title={VENDOR_DOCUMENT_LABELS[kind]}
                  attention={complianceMissing}
                  address={`${sectionLabel} · ${doc?.fileName ?? "—"}`}
                  leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                  // On file shows date + status; a missing row leaves this
                  // blank rather than repeating "Missing" — the Missing tab
                  // already says the bucket. A compliance gap still gets its
                  // own red statusWord (a distinct, higher-stakes callout).
                  facts={doc ? [safeFormatDateTime(doc.uploadedAt), "On file"].filter(Boolean).join(" · ") : undefined}
                  statusWord={complianceMissing ? { tone: "bad", text: "Missing — required" } : undefined}
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
