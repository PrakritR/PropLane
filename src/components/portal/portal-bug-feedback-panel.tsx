"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import {
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import {
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { PortalFeedbackSubmitModal } from "@/components/portal/portal-feedback-submit-modal";
import {
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_MOBILE_DETAIL_EXPAND,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
  PortalTableInlineExpand,
} from "@/components/portal/portal-data-table";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import {
  readBugFeedbackRows,
  syncBugFeedbackFromServer,
  deleteBugFeedbackRow,
  type BugFeedbackReporterRole,
  type BugFeedbackStatus,
  type PortalBugFeedbackRow,
} from "@/lib/portal-bug-feedback";
import { feedbackStatusLabel } from "@/lib/portal-bug-feedback-utils";
import { usePortalSession } from "@/hooks/use-portal-session";

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function feedbackStatusClass(status: BugFeedbackStatus) {
  switch (status) {
    case "open":
      return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "in_progress":
      return "portal-badge-info ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "completed":
      return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    default:
      return "bg-accent/30 text-muted ring-1 ring-border";
  }
}

export function PortalBugFeedbackPanel({
  reporterRole,
  embedded = false,
}: {
  reporterRole: BugFeedbackReporterRole;
  /** Render as a plain card section (used inside the Settings page) instead of a full page shell. */
  embedded?: boolean;
}) {
  const { showToast } = useAppUi();
  const session = usePortalSession();
  const [rows, setRows] = useState<PortalBugFeedbackRow[]>(() => readBugFeedbackRows());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const refresh = useCallback(async () => {
    const result = await syncBugFeedbackFromServer({ force: true });
    setRows(result.rows);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const onRefresh = () => void refresh();
    window.addEventListener(ADMIN_UI_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_UI_EVENT, onRefresh);
  }, [refresh]);

  const myRows = useMemo(() => {
    const uid = session.userId ?? "";
    const email = (session.email ?? "").trim().toLowerCase();
    return rows
      .filter((r) => (uid && r.reporterUserId === uid) || (email && r.reporterEmail === email))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [rows, session.email, session.userId]);

  const handleDelete = async (row: PortalBugFeedbackRow) => {
    if (!window.confirm("Delete this feedback item?")) return;
    setDeletingId(row.id);
    try {
      await deleteBugFeedbackRow(row.id);
      if (expandedId === row.id) setExpandedId(null);
      await refresh();
      showToast("Deleted.");
    } catch {
      showToast("Could not delete.");
    } finally {
      setDeletingId(null);
    }
  };

  const renderRowDetail = (row: PortalBugFeedbackRow) => (
    <div className="space-y-4">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{row.description}</p>
      {row.attachmentUrls && row.attachmentUrls.length > 0 ? (
        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Attachments</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.attachmentUrls.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-lg border border-border bg-card transition hover:opacity-90"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="Feedback attachment" className="h-24 w-24 object-cover" />
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <PortalTableDetailActions>
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
          disabled={deletingId === row.id}
          onClick={() => handleDelete(row)}
        >
          {deletingId === row.id ? "Deleting…" : "Delete"}
        </Button>
      </PortalTableDetailActions>
    </div>
  );

  const feedbackCards = myRows.length > 0 ? (
    <div className="space-y-2">
      {myRows.map((row) => {
        const open = expandedId === row.id;
        return (
          <div key={row.id} className={PORTAL_MOBILE_CARD_CLASS}>
            <button
              type="button"
              className="flex w-full gap-2 text-left"
              onClick={() => setExpandedId((cur) => (cur === row.id ? null : row.id))}
              aria-expanded={open}
            >
              <div className="flex min-w-0 flex-1 items-start justify-between gap-2.5">
                <div className="min-w-0 flex-1">
                  <PortalTableInlineExpand expanded={open} className="truncate text-sm font-semibold text-foreground">
                    {row.title}
                  </PortalTableInlineExpand>
                  <p className="mt-0.5 truncate text-xs text-muted">Submitted {formatWhen(row.createdAt)}</p>
                </div>
                <span
                  className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${feedbackStatusClass(row.status)}`}
                >
                  {feedbackStatusLabel(row.status)}
                </span>
              </div>
            </button>
            {open ? <div className={PORTAL_MOBILE_DETAIL_EXPAND}>{renderRowDetail(row)}</div> : null}
          </div>
        );
      })}
    </div>
  ) : null;

  const addFeedbackRow = (
    <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
      <PortalListAddRow
        label="Add feedback"
        hint="Share an idea or report an issue"
        icon={MessageSquarePlus}
        onClick={() => setSubmitOpen(true)}
        dataAttr="feedback-add"
      />
    </div>
  );

  const body = (
    <div className="space-y-2">
      {feedbackCards}
      {addFeedbackRow}
    </div>
  );

  return (
    <>
      {embedded ? (
        <PortalSettingsSection title="Feedback" description="Report issues or share product feedback.">
          <PortalSettingsGroup>
            <div className="px-4 py-4">{body}</div>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ) : (
        <ManagerPortalPageShell title="Feedback">{body}</ManagerPortalPageShell>
      )}

      <PortalFeedbackSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        reporterRole={reporterRole}
        reporterUserId={session.userId}
        reporterEmail={session.email ?? ""}
        reporterName={session.email ?? ""}
        onSubmitted={refresh}
      />
    </>
  );
}
