"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
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
import {
  DOCUMENT_CATEGORY_LABELS,
  type ManagerDocumentDTO,
} from "@/lib/documents/manager-documents";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Documents shared from a manager's library to resident or vendor portals. */
export function PortalSharedDocumentsTable({
  listUrl,
  signedUrlBase,
  emptyMessage,
  demoMessage,
  demo = false,
}: {
  listUrl: string;
  signedUrlBase: string;
  emptyMessage: string;
  demoMessage: string;
  demo?: boolean;
}) {
  const { showToast } = useAppUi();
  const [documents, setDocuments] = useState<ManagerDocumentDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [preview, setPreview] = useState<ManagerDocumentDTO | null>(null);

  const load = useCallback(async () => {
    if (demo) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    setAccessDenied(false);
    try {
      const res = await fetch(listUrl, { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      /*
        Not signed in, or not linked yet, is an ORDINARY state here — not a
        failure to shout about. It used to throw like any other error, so the
        tab greeted an unauthorized vendor with a red "Failed to load shared
        documents." toast and a 401 in the console, while the sibling tab in
        the same panel answered the identical condition with a calm banner.
        Same condition, same explanation.
      */
      if (res.status === 401 || res.status === 403) {
        setDocuments([]);
        setAccessDenied(true);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Failed to load shared documents.");
      setDocuments((data.documents as ManagerDocumentDTO[]) ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load shared documents.");
    } finally {
      setLoading(false);
    }
  }, [demo, listUrl, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (demo) {
    return <PortalDataTableEmpty message={demoMessage} icon="document" />;
  }

  if (accessDenied) {
    return (
      <PortalDataTableEmpty
        icon="document"
        message="Sign in with a vendor account to see documents shared with you."
      />
    );
  }

  if (!loading && documents.length === 0) {
    return <PortalDataTableEmpty message={emptyMessage} icon="document" />;
  }

  const renderActions = (doc: ManagerDocumentDTO) => (
    <PortalTableDetailActions>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        data-attr="shared-document-preview"
        onClick={() => setPreview(doc)}
      >
        Preview
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        data-attr="shared-document-download"
        onClick={() => {
          triggerDocumentDownload(`${signedUrlBase}/${doc.id}/signed-url?download=1`);
        }}
      >
        Download
      </Button>
    </PortalTableDetailActions>
  );

  return (
    <>
      <div className="space-y-2 lg:hidden">
        {documents.map((doc) => {
          const open = expandedId === doc.id;
          return (
            <div key={doc.id} className={PORTAL_MOBILE_CARD_CLASS}>
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setExpandedId((cur) => (cur === doc.id ? null : doc.id))}
              >
                <p className="font-semibold text-foreground">{doc.displayName}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {DOCUMENT_CATEGORY_LABELS[doc.category]} · {formatDate(doc.createdAt)}
                </p>
              </button>
              {open ? <div className="mt-3 border-t border-border pt-3">{renderActions(doc)}</div> : null}
            </div>
          );
        })}
      </div>

      <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
        <div className={PORTAL_DATA_TABLE_SCROLL}>
          <table className={PORTAL_DATA_TABLE}>
            <thead>
              <tr className={PORTAL_TABLE_HEAD_ROW}>
                <th className={`${MANAGER_TABLE_TH} text-left`}>Name</th>
                <th className={`${MANAGER_TABLE_TH} text-left`}>Category</th>
                <th className={`${MANAGER_TABLE_TH} text-left`}>Size</th>
                <th className={`${MANAGER_TABLE_TH} text-left`}>Shared</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const open = expandedId === doc.id;
                return (
                  <Fragment key={doc.id}>
                    <tr
                      className={PORTAL_TABLE_TR_EXPANDABLE}
                      onClick={createPortalRowExpandClick(() => setExpandedId((cur) => (cur === doc.id ? null : doc.id)))}
                      aria-expanded={open}
                    >
                      <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                        <PortalTableInlineExpand expanded={open}>{doc.displayName}</PortalTableInlineExpand>
                      </td>
                      <td className={PORTAL_TABLE_TD}>
                        <Badge tone="neutral">{DOCUMENT_CATEGORY_LABELS[doc.category]}</Badge>
                      </td>
                      <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{formatBytes(doc.sizeBytes)}</td>
                      <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{formatDate(doc.createdAt)}</td>
                    </tr>
                    {open ? (
                      <tr className={PORTAL_TABLE_DETAIL_ROW}>
                        <td colSpan={4} className={PORTAL_TABLE_DETAIL_CELL}>
                          {renderActions(doc)}
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

      <SharedPreviewModal
        doc={preview}
        signedUrlBase={signedUrlBase}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

function SharedPreviewModal({
  doc,
  signedUrlBase,
  onClose,
}: {
  doc: ManagerDocumentDTO | null;
  signedUrlBase: string;
  onClose: () => void;
}) {
  const { showToast } = useAppUi();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!doc) {
      setUrl(null);
      return;
    }
    setLoading(true);
    void fetch(`${signedUrlBase}/${doc.id}/signed-url`, { credentials: "include" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not load preview.");
        setUrl(String(data.url ?? ""));
      })
      .catch((e) => showToast(e instanceof Error ? e.message : "Could not load preview."))
      .finally(() => setLoading(false));
  }, [doc, signedUrlBase, showToast]);

  return (
    <Modal open={Boolean(doc)} onClose={onClose} title={doc?.displayName ?? "Preview"} panelClassName="max-w-4xl">
      {loading ? <p className="text-sm text-muted">Loading preview…</p> : null}
      {!loading && url && doc ? (
        isImageMime(doc.mimeType) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={doc.displayName} className="max-h-[70vh] w-full rounded-xl object-contain" />
        ) : doc.mimeType === "application/pdf" ? (
          <iframe title={doc.displayName} src={url} className="h-[70vh] w-full rounded-xl border border-border" />
        ) : (
          <p className="text-sm text-muted">Preview is not available for this file type. Use Download.</p>
        )
      ) : null}
      {doc ? (
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            onClick={() => triggerDocumentDownload(`${signedUrlBase}/${doc.id}/signed-url?download=1`)}
          >
            Download
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
