"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Download, Eye, FileText, Trash2, Upload } from "lucide-react";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { DocumentInlineViewer, triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
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
import { DOCUMENT_CATEGORY_LABELS, type ManagerDocumentDTO } from "@/lib/documents/manager-documents";

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

/** Vendor Documents — Mine / From managers command bar + upload workspace, one source-filtered list. */
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
  const [expandedKind, setExpandedKind] = useState<VendorDocumentKind | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [source, setSource] = useState<"all" | "mine" | "managers">("all");
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
    setExpandedKind(null);
    setSharedExpandedId(null);
    setPreviewKind(null);
    setListSearch("");
  }, [source]);

  const documentsByKind = useMemo(() => {
    const map = new Map<VendorDocumentKind, VendorDocumentRecord>();
    for (const doc of documents) map.set(doc.kind, doc);
    return map;
  }, [documents]);

  const rows = useMemo(() => {
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
  }, [documentsByKind, listSearch]);

  const previewDoc = previewKind ? documentsByKind.get(previewKind) : undefined;
  const includesMine = source !== "managers";
  const includesManagers = source !== "mine";
  const ownRows = includesMine ? rows : [];
  const managerRows = includesManagers
    ? sharedDocuments.filter((doc) => {
        const needle = listSearch.trim().toLowerCase();
        return !needle || `${doc.displayName} ${DOCUMENT_CATEGORY_LABELS[doc.category]}`.toLowerCase().includes(needle);
      })
    : [];
  const visibleRowCount = ownRows.length + managerRows.length;

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

  // Icon-only row actions (C162) — matches the shared-document rows below
  // rather than the old labeled "Upload PDF"/"View"/"Download"/"Remove" buttons.
  const renderRowActions = (kind: VendorDocumentKind, doc: VendorDocumentRecord | undefined) => {
    const busy = uploadingKind === kind;
    return (
      <div className="flex items-center gap-1">
        <PortalIconAction
          icon={Upload}
          label={busy ? "Uploading…" : doc ? "Replace PDF" : "Upload PDF"}
          disabled={busy}
          data-attr={`vendor-documents-upload-${kind}`}
          onClick={() => fileRefs.current[kind]?.click()}
        />
        {doc ? (
          <>
            <PortalIconAction
              icon={Eye}
              label={previewKind === kind ? "Hide preview" : "View"}
              active={previewKind === kind}
              data-attr={`vendor-documents-view-${kind}`}
              onClick={() => setPreviewKind((cur) => (cur === kind ? null : kind))}
            />
            <PortalIconAction
              icon={Download}
              label="Download"
              data-attr={`vendor-documents-download-${kind}`}
              onClick={() => {
                if (demo) {
                  showToast("Download is available after you sign in to a live vendor account.");
                  return;
                }
                triggerDocumentDownload(doc.url, doc.fileName);
              }}
            />
            <PortalIconAction
              icon={Trash2}
              label="Remove"
              tone="danger"
              data-attr={`vendor-documents-remove-${kind}`}
              onClick={() => removeDocument(kind)}
            />
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
      </div>
    );
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

  return (
    <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        filterRow={
          <div className="flex items-center gap-2 text-xs font-semibold text-muted">
            Source
            <FieldSingleSelect
              label="Document source"
              hideLabel
              value={source}
              onChange={(next) => setSource(next as "all" | "mine" | "managers")}
              options={[
                { value: "all", label: "All" },
                { value: "mine", label: "Mine" },
                { value: "managers", label: "From managers" },
              ]}
              variant="pill"
              dataAttr="vendor-documents-source"
            />
          </div>
        }
        search={
          {
            value: listSearch,
            onChange: setListSearch,
            placeholder: "Search documents",
            dataAttr: "vendor-documents-search",
          }
        }
        primary={
          source !== "managers" ? (
            // Same upload-cloud glyph as manager Documents' primary action
            // (`pro-documents-panel.tsx`) — this used to fall back to the
            // default plain "+", a different icon language for the identical
            // "add a document" action (AXI night sweep area 2h).
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
          add={includesMine ? {
            ariaLabel: portalListAddPrimaryLabel("document"),
            onClick: () => setUploadOpen(true),
            dataAttr: "vendor-documents-list-add",
          } : undefined}
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
          {ownRows.map(({ kind, section, doc }) => {
            const expanded = expandedKind === kind;
            return (
              <div key={kind}>
                <PortalPropertyRecordRow
                  title={VENDOR_DOCUMENT_LABELS[kind]}
                  address={doc?.fileName ? `Mine · ${doc.fileName}` : `Mine · ${section}`}
                  leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                  // The status is a plain fact beside the date — never a pill.
                  facts={[doc ? safeFormatDateTime(doc.uploadedAt) : "", vendorDocumentStatusLabel(doc)].filter(Boolean).join(" · ")}
                  selected={expanded}
                  onOpen={() => setExpandedKind((cur) => (cur === kind ? null : kind))}
                  dataAttr="vendor-document-row"
                />
                {expanded ? <div className="mb-2 px-1">{renderRowActions(kind, doc)}</div> : null}
              </div>
            );
          })}
          {managerRows.map((doc) => {
            const expanded = sharedExpandedId === doc.id;
            return (
              <div key={doc.id}>
                <PortalPropertyRecordRow
                  title={doc.displayName}
                  address={`From managers · ${DOCUMENT_CATEGORY_LABELS[doc.category]}`}
                  leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                  facts={safeFormatDateTime(doc.createdAt)}
                  selected={expanded}
                  onOpen={() => setSharedExpandedId((current) => (current === doc.id ? null : doc.id))}
                  dataAttr="vendor-document-row"
                />
                {expanded ? (
                  <div className="mb-2 px-1">
                    <div className="flex items-center gap-1">
                      <PortalIconAction icon={FileText} label="Preview" data-attr="vendor-shared-document-preview" onClick={() => void previewSharedDocument(doc)} />
                      <PortalIconAction icon={FileText} label="Download" data-attr="vendor-shared-document-download" onClick={() => triggerDocumentDownload(`/api/vendor/shared-documents/${doc.id}/signed-url?download=1`)} />
                    </div>
                  </div>
                ) : null}
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
