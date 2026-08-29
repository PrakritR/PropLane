"use client";

import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalStatusPills,
  MANAGER_TABLE_TH,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DETAIL_BTN,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR_EXPANDABLE,
  PortalDataTableEmpty,
  PortalTableDetailActions,
  PortalTableInlineExpand,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_UPLOAD_ACCEPT,
  DOCUMENT_VISIBILITY_LABELS,
  DOCUMENT_VISIBILITY_VALUES,
  MAX_DOCUMENT_BYTES,
  documentSignatureBadgeTone,
  type ManagerDocumentCategory,
  type ManagerDocumentDTO,
  type ManagerDocumentVisibility,
} from "@/lib/documents/manager-documents";
import {
  documentExpirationBucket,
  documentMatchesExpiryFilter,
  expirationBadgeTone,
  expirationBucketLabel,
  formatExpiryDate,
  suggestedExpiryDateInput,
  summarizeDocumentExpiration,
} from "@/lib/documents/document-expiration";
import { loadDocumentExpirationSummary } from "@/lib/manager-document-expiry-client";
import { useSearchParams } from "next/navigation";
import { MANAGER_VENDORS_EVENT, syncManagerVendorsFromServer, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { FileUp } from "lucide-react";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";

const SCOPE_FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All scopes" },
  { id: "manager", label: "Manager-level" },
  { id: "property", label: "Property" },
  { id: "lease", label: "Lease" },
  { id: "resident", label: "Resident" },
  { id: "vendor", label: "Vendor" },
  { id: "work_order", label: "Work order" },
];

const SCOPE_LABELS: Record<ManagerDocumentDTO["scopeKind"], string> = {
  manager: "Manager-level",
  property: "Property",
  unit: "Unit",
  lease: "Lease",
  resident: "Resident",
  vendor: "Vendor",
  work_order: "Work order",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export type DocumentLibraryFilterFieldsProps = {
  search?: string;
  onSearchChange?: (value: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  scopeFilter: string;
  onScopeFilterChange: (value: string) => void;
  propertyFilter: string;
  onPropertyFilterChange: (value: string) => void;
  expiryFilter: string;
  onExpiryFilterChange: (value: string) => void;
  expiryPills: { id: string; label: string; count: number; alert?: boolean }[];
  categoryFilterOptions: { id: string; label: string }[];
  scopeFilterOptions: { id: string; label: string }[];
  propertyFilterOptions: { id: string; label: string }[];
  propertyOptions: { id: string; label: string }[];
};

export function DocumentLibraryFilterFields(props: DocumentLibraryFilterFieldsProps) {
  return (
    <FilterFieldsAccordion>
      <DocumentLibraryFilterFieldsBody {...props} />
    </FilterFieldsAccordion>
  );
}

function DocumentLibraryFilterFieldsBody({
  search,
  onSearchChange,
  categoryFilter,
  onCategoryFilterChange,
  scopeFilter,
  onScopeFilterChange,
  propertyFilter,
  onPropertyFilterChange,
  expiryFilter,
  onExpiryFilterChange,
  expiryPills,
  categoryFilterOptions,
  scopeFilterOptions,
  propertyFilterOptions,
  propertyOptions,
}: DocumentLibraryFilterFieldsProps) {
  const [draftCategoryFilter, setDraftCategoryFilter] = usePortalFilterDraft(
    categoryFilter,
    onCategoryFilterChange,
    "",
  );
  const [draftScopeFilter, setDraftScopeFilter] = usePortalFilterDraft(scopeFilter, onScopeFilterChange, "");
  const [draftPropertyFilter, setDraftPropertyFilter] = usePortalFilterDraft(
    propertyFilter,
    onPropertyFilterChange,
    "",
  );
  const [draftExpiryFilter, setDraftExpiryFilter] = usePortalFilterDraft(expiryFilter, onExpiryFilterChange, "");

  const categoryOptions = toFilterOptions(categoryFilterOptions, "All categories");
  const scopeOptions = toFilterOptions(scopeFilterOptions, "All scopes");
  const propertyListOptions = toFilterOptions(propertyFilterOptions, "All properties");

  return (
    <div className="flex flex-col gap-3">
      <ManagerPortalStatusPills
        tabs={expiryPills}
        activeId={draftExpiryFilter}
        onChange={setDraftExpiryFilter}
        activeTone="primary"
        compact
      />
      {onSearchChange ? (
        <Input
          type="search"
          value={search ?? ""}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name…"
          className="h-10 w-full text-sm"
          aria-label="Search documents"
          data-attr="document-search"
        />
      ) : null}
      <FilterCollapsibleSection
        sectionId="document-category"
        label="Category"
        summary={filterSingleSelectSummary(draftCategoryFilter, categoryOptions, "All categories")}
        empty={!draftCategoryFilter}
        menuOptionCount={categoryOptions.length}
        dataAttr="document-filter-category-trigger"
      >
        <FilterSingleSelectList
          options={categoryOptions}
          value={draftCategoryFilter}
          onChange={setDraftCategoryFilter}
          dataAttr="document-filter-category"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="document-scope"
        label="Scope"
        summary={filterSingleSelectSummary(draftScopeFilter, scopeOptions, "All scopes")}
        empty={!draftScopeFilter}
        menuOptionCount={scopeOptions.length}
        dataAttr="document-filter-scope-trigger"
      >
        <FilterSingleSelectList
          options={scopeOptions}
          value={draftScopeFilter}
          onChange={setDraftScopeFilter}
          dataAttr="document-filter-scope"
        />
      </FilterCollapsibleSection>
      {propertyOptions.length > 0 ? (
        <FilterCollapsibleSection
          sectionId="document-property"
          label="Property"
          summary={filterSingleSelectSummary(draftPropertyFilter, propertyListOptions, "All properties")}
          empty={!draftPropertyFilter}
          menuOptionCount={propertyListOptions.length}
          dataAttr="document-filter-property-trigger"
        >
          <FilterSingleSelectList
            options={propertyListOptions}
            value={draftPropertyFilter}
            onChange={setDraftPropertyFilter}
            dataAttr="document-filter-property"
          />
        </FilterCollapsibleSection>
      ) : null}
    </div>
  );
}

/**
 * `{id,label}` filter options as `{value,label}`, with a leading "clear" row. Some option
 * lists (SCOPE_FILTERS) already carry their own empty-id row, so prepending unconditionally
 * would render "All scopes" twice — only add one when the list lacks it.
 */
function toFilterOptions(
  options: { id: string; label: string }[],
  allLabel: string,
): { value: string; label: string }[] {
  const mapped = options.map((o) => ({ value: o.id, label: o.label }));
  return mapped.some((o) => o.value === "") ? mapped : [{ value: "", label: allLabel }, ...mapped];
}

export type ManagerDocumentLibraryHandle = {
  openUpload: () => void;
};

type ManagerDocumentLibraryProps = {
  userId: string | null;
  hideFilterChrome?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  categoryFilter?: string;
  onCategoryFilterChange?: (value: string) => void;
  scopeFilter?: string;
  onScopeFilterChange?: (value: string) => void;
  propertyFilter?: string;
  onPropertyFilterChange?: (value: string) => void;
  expiryFilter?: string;
  onExpiryFilterChange?: (value: string) => void;
  onExpiryPillsChange?: (pills: DocumentLibraryFilterFieldsProps["expiryPills"]) => void;
};

export const ManagerDocumentLibrary = forwardRef<ManagerDocumentLibraryHandle, ManagerDocumentLibraryProps>(
  function ManagerDocumentLibrary(
    {
      userId,
      hideFilterChrome = false,
      search: searchProp,
      onSearchChange,
      categoryFilter: categoryFilterProp,
      onCategoryFilterChange,
      scopeFilter: scopeFilterProp,
      onScopeFilterChange,
      propertyFilter: propertyFilterProp,
      onPropertyFilterChange,
      expiryFilter: expiryFilterProp,
      onExpiryFilterChange,
      onExpiryPillsChange,
    },
    ref,
  ) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const searchParams = useSearchParams();

  const [documents, setDocuments] = useState<ManagerDocumentDTO[]>([]);
  const [loading, setLoading] = useState(!demo);
  const [searchState, setSearchState] = useState("");
  const [categoryFilterState, setCategoryFilterState] = useState<string>("");
  const [scopeFilterState, setScopeFilterState] = useState<string>("");
  const [propertyFilterState, setPropertyFilterState] = useState<string>("");
  const [expiryFilterState, setExpiryFilterState] = useState("");
  const search = searchProp ?? searchState;
  const setSearch = onSearchChange ?? setSearchState;
  const categoryFilter = categoryFilterProp ?? categoryFilterState;
  const setCategoryFilter = onCategoryFilterChange ?? setCategoryFilterState;
  const scopeFilter = scopeFilterProp ?? scopeFilterState;
  const setScopeFilter = onScopeFilterChange ?? setScopeFilterState;
  const propertyFilter = propertyFilterProp ?? propertyFilterState;
  const setPropertyFilter = onPropertyFilterChange ?? setPropertyFilterState;
  const expiryFilter = expiryFilterProp ?? expiryFilterState;
  const setExpiryFilter = onExpiryFilterChange ?? setExpiryFilterState;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  useImperativeHandle(ref, () => ({ openUpload: () => setUploadOpen(true) }), []);
  const [renameTarget, setRenameTarget] = useState<ManagerDocumentDTO | null>(null);
  const [versionTarget, setVersionTarget] = useState<ManagerDocumentDTO | null>(null);
  const [previewTarget, setPreviewTarget] = useState<ManagerDocumentDTO | null>(null);
  const [vendorRows, setVendorRows] = useState<ManagerVendorRow[]>([]);

  const propertyOptions = useMemo(() => buildManagerPropertyFilterOptions(userId), [userId]);

  /**
   * A document write changes the dashboard's expiry counts, but that banner is
   * now TTL-guarded, so without this it could show counts up to the TTL stale
   * after an upload/edit/delete. Forcing a read on the SAME user key the
   * dashboard reads guarantees its next read is newer than the write.
   * Fire-and-forget: a failed refresh must never fail the write.
   */
  const refreshExpirySummary = useCallback(() => {
    if (demo) return;
    void loadDocumentExpirationSummary({ userId, force: true }).catch(() => {});
  }, [demo, userId]);

  const categoryFilterOptions = useMemo(
    () => DOCUMENT_CATEGORIES.map((c) => ({ id: c, label: DOCUMENT_CATEGORY_LABELS[c] })),
    [],
  );

  const scopeFilterOptions = useMemo(
    () => SCOPE_FILTERS.map((s) => ({ id: s.id, label: s.label })),
    [],
  );

  const propertyFilterOptions = useMemo(
    () => propertyOptions.map((p) => ({ id: p.id, label: p.label })),
    [propertyOptions],
  );

  useEffect(() => {
    const q = searchParams.get("expiry") ?? "";
    setExpiryFilter(q);
  }, [searchParams]);

  const expirySummary = useMemo(() => summarizeDocumentExpiration(documents), [documents]);

  const filteredDocuments = useMemo(
    () => documents.filter((d) => documentMatchesExpiryFilter(d.expiresAt, expiryFilter)),
    [documents, expiryFilter],
  );

  const expiryPills = useMemo(() => {
    let expiring30 = 0;
    let expiring90 = 0;
    for (const doc of documents) {
      const bucket = documentExpirationBucket(doc.expiresAt);
      if (bucket === "within30") expiring30 += 1;
      if (bucket === "within30" || bucket === "within60" || bucket === "within90") expiring90 += 1;
    }
    return [
      { id: "", label: "All", count: documents.length },
      { id: "expired", label: "Expired", count: expirySummary.expired, alert: expirySummary.expired > 0 },
      { id: "expiring30", label: "Expiring ≤30d", count: expiring30, alert: expiring30 > 0 },
      { id: "expiring90", label: "Expiring ≤90d", count: expiring90 },
    ];
  }, [documents, expirySummary.expired]);

  useEffect(() => {
    onExpiryPillsChange?.(expiryPills);
  }, [expiryPills, onExpiryPillsChange]);

  useEffect(() => {
    if (demo) return;
    void syncManagerVendorsFromServer().then(setVendorRows);
    const onVendors = () => void syncManagerVendorsFromServer({ force: true }).then(setVendorRows);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
  }, [demo]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (demo) {
        setDocuments([]);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (categoryFilter) params.set("category", categoryFilter);
        if (scopeFilter) params.set("scope", scopeFilter);
        if (propertyFilter) params.set("propertyId", propertyFilter);
        if (search.trim()) params.set("q", search.trim());
        const res = await fetch(`/api/manager-documents?${params}`, { credentials: "include", signal });
        const data = await res.json();
        if (signal?.aborted) return;
        if (!res.ok) throw new Error(data.error ?? "Failed to load documents.");
        setDocuments((data.documents as ManagerDocumentDTO[]) ?? []);
      } catch (e) {
        if (signal?.aborted) return;
        showToast(e instanceof Error ? e.message : "Failed to load documents.");
      } finally {
        setLoading(false);
      }
    },
    [demo, categoryFilter, scopeFilter, propertyFilter, search, showToast],
  );

  // Debounce so typing in search doesn't fire a request per keystroke; abort
  // superseded requests so a slow stale response can't overwrite fresh results.
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => void load(controller.signal), 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [load]);

  const handleDelete = useCallback(
    async (doc: ManagerDocumentDTO) => {
      if (!window.confirm(`Delete "${doc.displayName}"? It will be removed from your library.`)) return;
      try {
        const res = await fetch(`/api/manager-documents/${doc.id}`, { method: "DELETE", credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Failed to delete document.");
        setDocuments((cur) => cur.filter((d) => d.id !== doc.id));
        refreshExpirySummary();
        showToast("Document deleted.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Failed to delete document.");
      }
    },
    [refreshExpirySummary, showToast],
  );

  const handleShareLink = useCallback(
    async (doc: ManagerDocumentDTO) => {
      try {
        const res = await fetch(`/api/manager-documents/${doc.id}/share-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ expiresInDays: 7 }),
        });
        const data = (await res.json()) as { link?: { url?: string }; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to create share link.");
        const url = data.link?.url ?? "";
        if (!url) throw new Error("No share URL returned.");
        await navigator.clipboard.writeText(url);
        showToast("Share link copied (expires in 7 days).");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Failed to create share link.");
      }
    },
    [showToast],
  );

  const handleRequestSignature = useCallback(
    async (doc: ManagerDocumentDTO) => {
      if (doc.visibility !== "resident") {
        showToast("Set visibility to “Share with resident” before requesting a signature.");
        return;
      }
      try {
        const res = await fetch(`/api/manager-documents/${doc.id}/request-signature`, {
          method: "POST",
          credentials: "include",
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to request signature.");
        setDocuments((cur) =>
          cur.map((row) =>
            row.id === doc.id
              ? { ...row, signatureStatus: "pending", signatureRequestedAt: new Date().toISOString() }
              : row,
          ),
        );
        showToast("Signature requested. Resident notified in inbox.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Failed to request signature.");
      }
    },
    [showToast],
  );

  const propertyLabel = useCallback(
    (id: string | null | undefined) => propertyOptions.find((p) => p.id === id)?.label ?? id ?? "",
    [propertyOptions],
  );

  const scopeSummary = useCallback(
    (doc: ManagerDocumentDTO): string => {
      switch (doc.scopeKind) {
        case "property":
          return `${SCOPE_LABELS.property} · ${propertyLabel(doc.scope.propertyId)}`;
        case "resident":
          return `${SCOPE_LABELS.resident}${doc.scope.residentEmail ? ` · ${doc.scope.residentEmail}` : ""}`;
        case "vendor":
          return `${SCOPE_LABELS.vendor}`;
        case "work_order":
          return `${SCOPE_LABELS.work_order}`;
        case "lease":
          return `${SCOPE_LABELS.lease}`;
        case "unit":
          return `${SCOPE_LABELS.unit} · ${doc.scope.unitLabel ?? ""}`;
        default:
          return SCOPE_LABELS.manager;
      }
    },
    [propertyLabel],
  );

  const renderActions = (doc: ManagerDocumentDTO) => (
    <PortalTableDetailActions placement="top">
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={() => setPreviewTarget(doc)}
        data-attr="document-preview"
      >
        Preview
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={() => setRenameTarget(doc)}
        data-attr="document-edit"
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={() => setVersionTarget(doc)}
        data-attr="document-upload-version"
      >
        New version
      </Button>
      {doc.visibility === "resident" && doc.signatureStatus !== "signed" ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          onClick={() => handleRequestSignature(doc)}
          data-attr="document-request-signature"
        >
          Request signature
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={() => handleShareLink(doc)}
        data-attr="document-share-link"
      >
        Share link
      </Button>
      <Button
        type="button"
        variant="danger"
        className={PORTAL_DETAIL_BTN}
        onClick={() => handleDelete(doc)}
        data-attr="document-delete"
      >
        Delete
      </Button>
    </PortalTableDetailActions>
  );

  const renderDetail = (doc: ManagerDocumentDTO) => (
    <>
      {renderActions(doc)}
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Type</dt>
          <dd className="truncate">{doc.mimeType}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Size</dt>
          <dd>{formatBytes(doc.sizeBytes)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Visibility</dt>
          <dd>{DOCUMENT_VISIBILITY_LABELS[doc.visibility]}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Scope</dt>
          <dd className="truncate">{scopeSummary(doc)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Uploaded</dt>
          <dd>{formatDate(doc.createdAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Signature</dt>
          <dd>
            {doc.signatureStatus ? (
              <Badge tone={documentSignatureBadgeTone(doc.signatureStatus)}>
                {doc.signatureStatus === "pending" ? "Signature pending" : doc.signatureStatus}
              </Badge>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-foreground/70">Expires</dt>
          <dd>
            {doc.expiresAt ? (
              <Badge tone={expirationBadgeTone(documentExpirationBucket(doc.expiresAt))}>
                {formatExpiryDate(doc.expiresAt)}
              </Badge>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
    </>
  );

  const empty = !loading && filteredDocuments.length === 0;
  const hasLibraryQuery = Boolean(search.trim() || categoryFilter || scopeFilter || propertyFilter || expiryFilter);

  const addDocumentRow = demo ? null : (
    <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
      <PortalListAddRow
        label="Add document"
        icon={FileUp}
        onClick={() => setUploadOpen(true)}
        dataAttr="documents-list-add"
      />
    </div>
  );

  const complianceBanner =
    !demo && (expirySummary.expired > 0 || expirySummary.within30 > 0) ? (
      <div
        className={`rounded-2xl border px-4 py-3 text-sm ${
          expirySummary.expired > 0
            ? "border-red-200 bg-red-50 text-red-900"
            : "border-amber-200 bg-amber-50 text-amber-950"
        }`}
        role="status"
      >
        <p className="font-medium">
          {expirySummary.expired > 0
            ? `${expirySummary.expired} document${expirySummary.expired === 1 ? "" : "s"} expired`
            : `${expirySummary.within30} document${expirySummary.within30 === 1 ? "" : "s"} expiring within 30 days`}
          {expirySummary.expired > 0 && expirySummary.within30 > 0
            ? ` · ${expirySummary.within30} expiring within 30 days`
            : ""}
        </p>
      </div>
    ) : null;

  return (
    <div className="space-y-3">
      {complianceBanner}
      {hideFilterChrome ? null : (
        <DocumentLibraryFilterFields
          search={search}
          onSearchChange={setSearch}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          scopeFilter={scopeFilter}
          onScopeFilterChange={setScopeFilter}
          propertyFilter={propertyFilter}
          onPropertyFilterChange={setPropertyFilter}
          expiryFilter={expiryFilter}
          onExpiryFilterChange={setExpiryFilter}
          expiryPills={expiryPills}
          categoryFilterOptions={categoryFilterOptions}
          scopeFilterOptions={scopeFilterOptions}
          propertyFilterOptions={propertyFilterOptions}
          propertyOptions={propertyOptions}
        />
      )}

      {demo ? (
        <PortalDataTableEmpty
          message="The document library needs a signed-in manager account. Sign in to upload and manage files."
          icon="document"
        />
      ) : loading && documents.length === 0 ? (
        <div className={PORTAL_DATA_TABLE_WRAP} role="status" aria-live="polite">
          <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading documents…</div>
        </div>
      ) : empty ? (
        <div className="space-y-3">
          {hasLibraryQuery ? (
            <PortalDataTableEmpty
              message="No documents match your search or filters."
              icon="document"
            />
          ) : null}
          {addDocumentRow}
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-2 lg:hidden">
            {filteredDocuments.map((doc) => {
              const expanded = expandedId === doc.id;
              return (
                <div key={doc.id} className={PORTAL_MOBILE_CARD_CLASS}>
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => setExpandedId((cur) => (cur === doc.id ? null : doc.id))}
                    aria-expanded={expanded}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <PortalTableInlineExpand expanded={expanded} className="font-semibold text-foreground">
                          <span className="truncate">{doc.displayName}</span>
                        </PortalTableInlineExpand>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {scopeSummary(doc)} · {formatBytes(doc.sizeBytes)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone="neutral">{DOCUMENT_CATEGORY_LABELS[doc.category]}</Badge>
                        {doc.expiresAt ? (
                          <Badge tone={expirationBadgeTone(documentExpirationBucket(doc.expiresAt))}>
                            {expirationBucketLabel(documentExpirationBucket(doc.expiresAt))}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  {expanded ? <div className="mt-3 border-t border-border pt-3">{renderDetail(doc)}</div> : null}
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Name</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Category</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Visibility</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Scope</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Size</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Expires</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocuments.map((doc) => (
                    <Fragment key={doc.id}>
                      <tr
                        className={PORTAL_TABLE_TR_EXPANDABLE}
                        onClick={createPortalRowExpandClick(() =>
                          setExpandedId((cur) => (cur === doc.id ? null : doc.id)),
                        )}
                        aria-expanded={expandedId === doc.id}
                      >
                        <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                          <PortalTableInlineExpand expanded={expandedId === doc.id}>
                            <span className="truncate">{doc.displayName}</span>
                          </PortalTableInlineExpand>
                        </td>
                        <td className={PORTAL_TABLE_TD}>
                          <Badge tone="neutral">{DOCUMENT_CATEGORY_LABELS[doc.category]}</Badge>
                        </td>
                        <td className={PORTAL_TABLE_TD}>
                          <Badge tone={doc.visibility === "manager" ? "neutral" : "info"}>
                            {DOCUMENT_VISIBILITY_LABELS[doc.visibility]}
                          </Badge>
                        </td>
                        <td className={`${PORTAL_TABLE_TD} truncate`}>{scopeSummary(doc)}</td>
                        <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{formatBytes(doc.sizeBytes)}</td>
                        <td className={PORTAL_TABLE_TD}>
                          {doc.expiresAt ? (
                            <Badge tone={expirationBadgeTone(documentExpirationBucket(doc.expiresAt))}>
                              {formatExpiryDate(doc.expiresAt)}
                            </Badge>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{formatDate(doc.createdAt)}</td>
                      </tr>
                      {expandedId === doc.id ? (
                        <tr className={PORTAL_TABLE_DETAIL_ROW}>
                          <td colSpan={7} className={PORTAL_TABLE_DETAIL_CELL}>
                            {renderDetail(doc)}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {addDocumentRow}
        </>
      )}

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        propertyOptions={propertyOptions}
        vendorRows={vendorRows.filter((v) => v.active !== false)}
        onUploaded={(doc) => {
          setDocuments((cur) => [doc, ...cur]);
          refreshExpirySummary();
          setUploadOpen(false);
        }}
      />

      <UploadModal
        open={Boolean(versionTarget)}
        onClose={() => setVersionTarget(null)}
        propertyOptions={propertyOptions}
        vendorRows={vendorRows.filter((v) => v.active !== false)}
        supersedeDocumentId={versionTarget?.id}
        title={versionTarget ? `Upload new version · ${versionTarget.displayName}` : "Upload new version"}
        versionMode
        onUploaded={(doc) => {
          setDocuments((cur) => [doc, ...cur.filter((row) => row.id !== versionTarget?.id)]);
          refreshExpirySummary();
          setVersionTarget(null);
        }}
      />

      <EditDocumentModal
        doc={renameTarget}
        vendorRows={vendorRows.filter((v) => v.active !== false)}
        onClose={() => setRenameTarget(null)}
        onSaved={(updated) => {
          setDocuments((cur) => cur.map((d) => (d.id === updated.id ? updated : d)));
          refreshExpirySummary();
          setRenameTarget(null);
        }}
      />

      <PreviewModal doc={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
});

function UploadModal({
  open,
  onClose,
  propertyOptions,
  vendorRows,
  onUploaded,
  supersedeDocumentId,
  title = "Upload document",
  versionMode = false,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: { id: string; label: string }[];
  vendorRows: { id: string; name: string }[];
  onUploaded: (doc: ManagerDocumentDTO) => void;
  supersedeDocumentId?: string;
  title?: string;
  versionMode?: boolean;
}) {
  const { showToast } = useAppUi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState<ManagerDocumentCategory>("other");
  const [propertyId, setPropertyId] = useState("");
  const [visibility, setVisibility] = useState<ManagerDocumentVisibility>("manager");
  const [residentEmail, setResidentEmail] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setDisplayName("");
      setCategory("other");
      setPropertyId("");
      setVisibility("manager");
      setResidentEmail("");
      setVendorId("");
      setExpiresAt("");
      setDragging(false);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const suggested = suggestedExpiryDateInput(category);
    if (suggested && !expiresAt) setExpiresAt(suggested);
  }, [category, open, expiresAt]);

  const pickFile = useCallback((f: File | null | undefined) => {
    if (!f) return;
    if (f.size > MAX_DOCUMENT_BYTES) {
      showToast("File exceeds the 25 MB limit.");
      return;
    }
    setFile(f);
    setDisplayName((cur) => cur || f.name.replace(/\.[^.]+$/, ""));
  }, [showToast]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!file) {
      showToast("Choose a file to upload.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("displayName", displayName.trim() || file.name);
      form.set("category", category);
      form.set("visibility", visibility);
      if (propertyId) form.set("propertyId", propertyId);
      if (visibility === "resident" && residentEmail.trim()) form.set("residentEmail", residentEmail.trim());
      if (visibility === "vendor" && vendorId) form.set("vendorId", vendorId);
      if (expiresAt.trim()) form.set("expiresAt", expiresAt.trim());
      if (supersedeDocumentId) form.set("supersedeDocumentId", supersedeDocumentId);
      const res = await fetch("/api/manager-documents", { method: "POST", body: form, credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      showToast(supersedeDocumentId ? "New version uploaded." : "Document uploaded.");
      onUploaded(data.document as ManagerDocumentDTO);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" onClick={() => submit()} disabled={busy || !file} data-attr="document-upload-submit">
            {busy ? "Uploading…" : versionMode ? "Upload version" : "Upload"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
            dragging ? "border-primary bg-primary/5" : "border-border bg-accent/20 hover:bg-accent/30"
          }`}
        >
          <span className="font-medium text-foreground">
            {file ? file.name : "Drag a file here or tap to choose"}
          </span>
          <span className="text-xs text-muted">
            {file ? formatBytes(file.size) : "PDF, images, or Office files up to 25 MB"}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={DOCUMENT_UPLOAD_ACCEPT}
          className="sr-only"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/70" htmlFor="doc-display-name">
            Name
          </label>
          <Input
            id="doc-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Document name"
          />
        </div>

        {versionMode ? (
          <p className="text-xs text-muted">
            Category, scope, and visibility carry over from the current version. The prior file stays in history.
          </p>
        ) : (
        <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground/70" htmlFor="doc-category">
              Category
            </label>
            <Select id="doc-category" value={category} onChange={(e) => setCategory(e.target.value as ManagerDocumentCategory)}>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DOCUMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground/70" htmlFor="doc-expires">
              Expiration (optional)
            </label>
            <Input
              id="doc-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              data-attr="document-expires-at"
            />
          </div>
          {propertyOptions.length > 0 ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground/70" htmlFor="doc-property">
                Property (optional)
              </label>
              <Select id="doc-property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                <option value="">Manager-level</option>
                {propertyOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/70" htmlFor="doc-visibility">
            Visibility
          </label>
          <Select
            id="doc-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ManagerDocumentVisibility)}
            data-attr="document-visibility"
          >
            {DOCUMENT_VISIBILITY_VALUES.map((v) => (
              <option key={v} value={v}>
                {DOCUMENT_VISIBILITY_LABELS[v]}
              </option>
            ))}
          </Select>
        </div>

        {visibility === "resident" ? (
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground/70" htmlFor="doc-resident-email">
              Resident email
            </label>
            <Input
              id="doc-resident-email"
              type="email"
              value={residentEmail}
              onChange={(e) => setResidentEmail(e.target.value)}
              placeholder="resident@example.com"
            />
          </div>
        ) : null}

        {visibility === "vendor" ? (
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground/70" htmlFor="doc-vendor">
              Vendor
            </label>
            <Select id="doc-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select vendor…</option>
              {vendorRows.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        </>
        )}
      </div>
    </Modal>
  );
}

function EditDocumentModal({
  doc,
  vendorRows,
  onClose,
  onSaved,
}: {
  doc: ManagerDocumentDTO | null;
  vendorRows: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (doc: ManagerDocumentDTO) => void;
}) {
  const { showToast } = useAppUi();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ManagerDocumentCategory>("other");
  const [visibility, setVisibility] = useState<ManagerDocumentVisibility>("manager");
  const [residentEmail, setResidentEmail] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setName(doc.displayName);
    setCategory(doc.category);
    setVisibility(doc.visibility);
    setResidentEmail(doc.scope.residentEmail ?? "");
    setVendorId(doc.scope.vendorId ?? "");
    setExpiresAt(doc.expiresAt ? doc.expiresAt.slice(0, 10) : "");
  }, [doc]);

  const submit = async () => {
    if (!doc) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("Name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/manager-documents/${doc.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          displayName: trimmed,
          category,
          visibility,
          residentEmail: visibility === "resident" ? residentEmail.trim() || null : null,
          vendorId: visibility === "vendor" ? vendorId || null : null,
          expiresAt: expiresAt.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      showToast(visibility === "manager" ? "Document updated." : "Document updated and shared.");
      onSaved(data.document as ManagerDocumentDTO);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(doc)}
      onClose={onClose}
      title="Edit document"
      dense
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" onClick={() => submit()} disabled={busy} data-attr="document-edit-submit">
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Document name" autoFocus />
        <Select value={category} onChange={(e) => setCategory(e.target.value as ManagerDocumentCategory)}>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {DOCUMENT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
        <Select value={visibility} onChange={(e) => setVisibility(e.target.value as ManagerDocumentVisibility)}>
          {DOCUMENT_VISIBILITY_VALUES.map((v) => (
            <option key={v} value={v}>
              {DOCUMENT_VISIBILITY_LABELS[v]}
            </option>
          ))}
        </Select>
        {visibility === "resident" ? (
          <Input
            type="email"
            value={residentEmail}
            onChange={(e) => setResidentEmail(e.target.value)}
            placeholder="resident@example.com"
          />
        ) : null}
        {visibility === "vendor" ? (
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select vendor…</option>
            {vendorRows.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/70" htmlFor="edit-doc-expires">
            Expiration
          </label>
          <Input
            id="edit-doc-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            data-attr="document-edit-expires-at"
          />
        </div>
      </div>
    </Modal>
  );
}

function PreviewModal({ doc, onClose }: { doc: ManagerDocumentDTO | null; onClose: () => void }) {
  const { showToast } = useAppUi();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!doc) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/manager-documents/${doc.id}/signed-url?download=1`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Download failed.");
      const fileRes = await fetch(data.url as string);
      if (!fileRes.ok) throw new Error("Download failed.");
      const blob = await fileRes.blob();
      const objectUrl = URL.createObjectURL(blob);
      triggerDocumentDownload(objectUrl, (data.fileName as string | undefined) ?? doc.displayName);
      // Revoke on the next tick — some browsers abort the save if the object URL
      // is released in the same task as the anchor click.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(false);
    }
  }, [doc, showToast]);

  useEffect(() => {
    if (!doc) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setUrl(null);
    void (async () => {
      try {
        const res = await fetch(`/api/manager-documents/${doc.id}/signed-url`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to open document.");
        if (!cancelled) setUrl(data.url as string);
      } catch (e) {
        if (!cancelled) showToast(e instanceof Error ? e.message : "Failed to open document.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, showToast]);

  const canInline = doc ? doc.mimeType === "application/pdf" || isImageMime(doc.mimeType) : false;

  return (
    <Modal
      open={Boolean(doc)}
      onClose={onClose}
      title={doc?.displayName ?? "Document"}
      panelClassName="max-w-3xl"
      footer={
        doc ? (
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              onClick={() => handleDownload()}
              disabled={downloading}
              data-attr="document-download"
            >
              {downloading ? "Downloading…" : "Download"}
            </Button>
          </ModalFooter>
        ) : null
      }
    >
      <div className="min-h-[50vh]">
        {loading ? (
          <p className="py-12 text-center text-sm text-muted">Loading preview…</p>
        ) : !url ? (
          <p className="py-12 text-center text-sm text-muted">Preview unavailable.</p>
        ) : !canInline ? (
          <p className="py-12 text-center text-sm text-muted">
            This file type can’t be previewed inline. Use Download to open it.
          </p>
        ) : doc && isImageMime(doc.mimeType) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={doc.displayName} className="mx-auto max-h-[70vh] max-w-full rounded-lg" />
        ) : (
          <iframe src={url} title={doc?.displayName ?? "Document"} className="h-[70vh] w-full rounded-lg border border-border" />
        )}
      </div>
    </Modal>
  );
}
