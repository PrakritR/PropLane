"use client";

import { useSearchParams } from "next/navigation";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterMultiSelectSummary,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import {
  deleteBugFeedbackRow,
  readBugFeedbackRows,
  syncBugFeedbackFromServer,
  updateBugFeedbackRow,
  type BugFeedbackReporterRole,
  type BugFeedbackStatus,
  type PortalBugFeedbackRow,
} from "@/lib/portal-bug-feedback";
import { roleGroupLabelForFeedback } from "@/lib/portal-bug-feedback-utils";

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

const STATUS_OPTIONS: { value: BugFeedbackStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

type StatusFilter = BugFeedbackStatus;

/** `?status=` is user-supplied — only a real feedback status is honoured. */
function feedbackStatusFromParam(raw: string | null): StatusFilter {
  return raw === "in_progress" || raw === "completed" ? raw : "open";
}
type SortFilter = "newest" | "oldest";
type PortalFilter = "managers" | "residents" | "vendors" | "admin";

/** Map a reporter role to the portal it came from (for the source filter). */
function portalForRole(role: BugFeedbackReporterRole): PortalFilter {
  if (role === "resident") return "residents";
  if (role === "vendor") return "vendors";
  if (role === "admin") return "admin";
  return "managers";
}

function sortFeedbackRows(rows: PortalBugFeedbackRow[], sort: SortFilter): PortalBugFeedbackRow[] {
  const next = [...rows];
  if (sort === "oldest") {
    return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Portal source — multi-select, same shape as the Accounts filter fields:
 * a real component rendered as a `FilterFieldsAccordion` child, so
 * `useFilterAccordionClose` resolves the enclosing accordion's context.
 * Replaces a labelled pill row that sat directly in the guarded list band.
 */
function FeedbackPortalFilterField({
  value,
  options,
  onChange,
}: {
  value: PortalFilter[];
  options: { value: PortalFilter; label: string }[];
  onChange: (next: PortalFilter[]) => void;
}) {
  const summary = filterMultiSelectSummary(value, options, "All portals");
  return (
    <FilterCollapsibleSection
      sectionId="feedback-portal"
      label="Portal"
      summary={summary}
      empty={value.length === 0}
      menuOptionCount={options.length}
      dataAttr="admin-feedback-portal-trigger"
    >
      <FilterCheckboxList
        options={options}
        selected={value}
        onChange={(next) => onChange(next as PortalFilter[])}
        dataAttr="admin-feedback-filter-portal"
      />
    </FilterCollapsibleSection>
  );
}

/** Sort order — single-select, same shape as {@link FeedbackPortalFilterField}. */
function FeedbackSortFilterField({
  value,
  onChange,
}: {
  value: SortFilter;
  onChange: (next: SortFilter) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
  ];
  const summary = filterSingleSelectSummary(value, options, "Newest first");
  return (
    <FilterCollapsibleSection
      sectionId="feedback-sort"
      label="Sort"
      summary={summary}
      empty={value === "newest"}
      menuOptionCount={options.length}
      dataAttr="admin-feedback-sort-trigger"
    >
      <FilterSingleSelectList
        options={options}
        value={value}
        onChange={(next) => onChange(next as SortFilter)}
        onPick={closeFieldMenu}
        dataAttr="admin-feedback-sort"
      />
    </FilterCollapsibleSection>
  );
}

export function AdminBugFeedbackClient({ embedded = false }: { embedded?: boolean }) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [rows, setRows] = useState<PortalBugFeedbackRow[]>(() => readBugFeedbackRows());
  const [portalFilter, setPortalFilter] = useState<PortalFilter[]>([]);
  // The open status is the URL, like every other portal list tab.
  const searchParams = useSearchParams();
  const statusFilter = feedbackStatusFromParam(searchParams.get("status"));
  const [sortFilter, setSortFilter] = useState<SortFilter>("newest");
  const [titleQuery, setTitleQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);
  const [applyingSchema, setApplyingSchema] = useState(false);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const result = await syncBugFeedbackFromServer({ force: true });
    setRows(result.rows);
    setLoadError(result.error ?? null);
    setSchemaMissing(Boolean(result.schemaMissing));
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
    const onRefresh = () => void refresh();
    window.addEventListener(ADMIN_UI_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_UI_EVENT, onRefresh);
  }, [refresh]);

  const portalRows = useMemo(() => {
    if (portalFilter.length === 0) return rows;
    return rows.filter((r) => portalFilter.includes(portalForRole(r.reporterRole)));
  }, [rows, portalFilter]);

  const visibleRows = useMemo(() => {
    const needle = titleQuery.trim().toLowerCase();
    const filtered = portalRows.filter((r) => {
      if (r.status !== statusFilter) return false;
      if (!needle) return true;
      return (r.title || "").toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle);
    });
    return sortFeedbackRows(filtered, sortFilter);
  }, [portalRows, statusFilter, sortFilter, titleQuery]);

  const portalOptions = useMemo((): { value: PortalFilter; label: string }[] => {
    const countFor = (portal: PortalFilter) =>
      rows.filter((r) => portalForRole(r.reporterRole) === portal).length;
    return [
      { value: "managers", label: `Managers (${countFor("managers")})` },
      { value: "residents", label: `Residents (${countFor("residents")})` },
      { value: "vendors", label: `Vendors (${countFor("vendors")})` },
      { value: "admin", label: `Admin (${countFor("admin")})` },
    ];
  }, [rows]);

  const statusTabs = useMemo(
    () => [
      {
        id: "open" as const,
        label: "Open",
        count: portalRows.filter((r) => r.status === "open").length,
        dataAttr: "admin-feedback-status-open",
      },
      {
        id: "in_progress" as const,
        label: "In progress",
        count: portalRows.filter((r) => r.status === "in_progress").length,
        dataAttr: "admin-feedback-status-in-progress",
      },
      {
        id: "completed" as const,
        label: "Completed",
        count: portalRows.filter((r) => r.status === "completed").length,
        dataAttr: "admin-feedback-status-completed",
      },
    ],
    [portalRows],
  );

  const hasAnyFeedback = rows.length > 0;

  const applySchema = async () => {
    setApplyingSchema(true);
    try {
      const res = await fetch("/api/admin/ensure-portal-schema", { method: "POST", credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not set up feedback storage.");
        return;
      }
      showToast("Feedback storage is ready. Ask managers to resubmit any reports sent before setup.");
      await refresh();
    } catch {
      showToast("Could not set up feedback storage.");
    } finally {
      setApplyingSchema(false);
    }
  };

  const saveStatus = async (row: PortalBugFeedbackRow, status: BugFeedbackStatus, adminNotes: string) => {
    setSavingId(row.id);
    try {
      await updateBugFeedbackRow(row.id, { status, adminNotes: adminNotes.trim() || undefined });
      await refresh();
      showToast("Updated.");
    } catch {
      showToast("Could not save.");
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (row: PortalBugFeedbackRow) => {
    if (!(await confirm({ description: "Delete this feedback item? This cannot be undone." }))) return;
    setDeletingId(row.id);
    try {
      await deleteBugFeedbackRow(row.id, { admin: true });
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
    <div className="space-y-4 text-sm text-muted">
      <p className="whitespace-pre-wrap leading-relaxed text-foreground">{row.description}</p>
      {row.stepsToReproduce ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Steps to reproduce</p>
          <p className="mt-1 whitespace-pre-wrap">{row.stepsToReproduce}</p>
        </div>
      ) : null}
      {row.attachmentUrls && row.attachmentUrls.length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Attachments</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.attachmentUrls.slice(0, 4).map((url) => (
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
      <AdminRowEditor
        row={row}
        saving={savingId === row.id}
        deleting={deletingId === row.id}
        onSave={(status, notes) => void saveStatus(row, status, notes)}
        onDelete={() => void handleDelete(row)}
      />
    </div>
  );

  /*
    Icon-only Filter popover, not a labelled pill row straight in the guarded
    list band (docs/portal-list-section-layout.md; the dev-mode guard flags a
    labelled pill reaching the list band on every render of a page that still
    does this — the same class of defect already fixed on Admin Accounts).
  */
  const filterActions = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([portalFilter.length > 0 ? "portal" : "", sortFilter !== "newest" ? sortFilter : ""])}
      compactPanel
      commandStripTrigger
      filterFieldCount={2}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setPortalFilter([]);
        setSortFilter("newest");
        setExpandedId(null);
      }}
      dataAttr="admin-feedback-filter-sheet-open"
    >
      <FilterFieldsAccordion>
        <FeedbackPortalFilterField
          value={portalFilter}
          options={portalOptions}
          onChange={(next) => {
            setPortalFilter(next);
            setExpandedId(null);
          }}
        />
        <FeedbackSortFilterField value={sortFilter} onChange={setSortFilter} />
      </FilterFieldsAccordion>
    </PortalFilterSortSheet>
  );

  /**
   * Bulk status moves.
   *
   * The dock carries the transitions that are NOT the tab you are standing in —
   * a Completed button on the Completed tab moves nothing. Delete deliberately
   * stays inside the row editor: it is the one action here that cannot be
   * undone, and the house rule keeps destructive actions behind the editor
   * rather than one click away in a bar.
   */
  const moveSelectedTo = async (status: BugFeedbackStatus) => {
    const targets = visibleRows.filter((r) => selectedIds.has(r.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      for (const row of targets) {
        await updateBugFeedbackRow(row.id, { status, adminNotes: row.adminNotes || undefined });
      }
      await refresh();
      showToast(targets.length === 1 ? "Updated." : `Updated ${targets.length} items.`);
      setSelectedIds(new Set());
    } catch {
      showToast("Could not update.");
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkActions = (
    <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
      {STATUS_OPTIONS.filter((o) => o.value !== statusFilter).map((o) => (
        <Button
          key={o.value}
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          disabled={bulkBusy}
          data-attr={`admin-feedback-bulk-${o.value}`}
          onClick={() => moveSelectedTo(o.value)}
        >
          {o.value === "open" ? "Reopen" : `Mark ${o.label.toLowerCase()}`}
        </Button>
      ))}
    </div>
  );

  const renderList = (listRows: PortalBugFeedbackRow[]) => (
    <PortalRecordListSurface
      onBulkClear={() => setSelectedIds(new Set())}
      bulkCount={listRows.filter((r) => selectedIds.has(r.id)).length}
      bulkActions={bulkActions}
      dataAttr="admin-feedback-list"
    >
      {listRows.map((row) => {
        const open = expandedId === row.id;
        return (
          <div key={row.id}>
            <PortalServiceRecordRow
              title={row.title}
              subtitle={`${roleGroupLabelForFeedback(row.reporterRole)} · ${row.reporterName || row.reporterEmail} · ${formatWhen(row.createdAt)}`}
              selected={open}
              checked={selectedIds.has(row.id)}
              onSelectedChange={() => toggleSelected(row.id)}
              onOpen={() => setExpandedId((cur) => (cur === row.id ? null : row.id))}
              dataAttr="admin-feedback-row"
            />
            {open ? (
              <div className="border-b border-border/50 bg-accent/10 px-4 py-4">{renderRowDetail(row)}</div>
            ) : null}
          </div>
        );
      })}
    </PortalRecordListSurface>
  );

  const content = (
    <>
      {schemaMissing ? (
        <div className="mb-5 rounded-2xl border px-4 py-3 text-sm portal-banner-pending">
          <p className="font-semibold">Feedback storage is not set up in Supabase yet.</p>
          <p className="mt-1 leading-relaxed">
            Manager and resident submissions cannot be saved until the{" "}
            <code className="rounded bg-black/[0.06] px-1 py-0.5 text-xs [html[data-theme=dark]_&]:bg-white/15">portal_bug_feedback_records</code> table exists.
            Run the migration in Supabase SQL Editor, or use the button below if{" "}
            <code className="rounded bg-black/[0.06] px-1 py-0.5 text-xs [html[data-theme=dark]_&]:bg-white/15">DATABASE_URL</code> is configured on the server.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="rounded-full" disabled={applyingSchema} onClick={() => applySchema()}>
              {applyingSchema ? "Setting up…" : "Set up feedback storage"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => {
                void (async () => {
                  try {
                    const res = await fetch("/api/admin/ensure-portal-schema", { credentials: "include" });
                    const body = (await res.json().catch(() => ({}))) as { migrationSql?: string };
                    const sql = body.migrationSql?.trim();
                    if (!sql) {
                      showToast("Could not load migration SQL.");
                      return;
                    }
                    await navigator.clipboard.writeText(sql);
                    showToast("Migration SQL copied. Paste into Supabase → SQL Editor → Run.");
                  } catch {
                    showToast("Could not copy migration SQL.");
                  }
                })();
              }}
            >
              Copy migration SQL
            </Button>
          </div>
        </div>
      ) : loadError ? (
        <div className="mb-5 rounded-2xl border px-4 py-3 text-sm portal-banner-danger">
          Could not load feedback: {loadError}
        </div>
      ) : null}

      {!hasAnyFeedback ? (
        <PortalDataTableEmpty icon="feedback" message="No feedback yet." />
      ) : visibleRows.length === 0 ? (
        <PortalDataTableEmpty icon="feedback" message="No feedback matching these filters." />
      ) : (
        renderList(visibleRows)
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6">
        <p className="text-sm font-semibold text-foreground">Feedback</p>
        {filterActions}
        {content}
      </div>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Feedback"
      hideTitleOnMobileNav
      navigationProvidesTitle
      titleInlineFilter={null}
      compactFilterRow
    >
      {/*
        Counted status tabs in the same header card every other list tab uses,
        with search + the portal/sort filter behind an icon-only Filter
        popover — not a labelled pill row in the list band.
      */}
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={statusTabs.map((t) => ({
          ...t,
          href: `/admin/bugs-feedback?status=${t.id}`,
        }))}
        activeDestinationId={statusFilter}
        destinationAriaLabel="Feedback status"
        search={{
          value: titleQuery,
          onChange: setTitleQuery,
          placeholder: "Search feedback",
          dataAttr: "admin-feedback-search",
          ariaLabel: "Search feedback",
        }}
        actions={filterActions}
      />
      {content}
    </ManagerPortalPageShell>
  );
}

function AdminRowEditor({
  row,
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  row: PortalBugFeedbackRow;
  saving: boolean;
  deleting: boolean;
  onSave: (status: BugFeedbackStatus, notes: string) => void;
  onDelete: () => void;
}) {
  const [status, setStatus] = useState<BugFeedbackStatus>(row.status);
  const [notes, setNotes] = useState(row.adminNotes ?? "");
  const busy = saving || deleting;

  useEffect(() => {
    queueMicrotask(() => {
      setStatus(row.status);
      setNotes(row.adminNotes ?? "");
    });
  }, [row.adminNotes, row.status]);

  return (
    <div className="rounded-xl border border-border bg-accent/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-36">
          <p className="mb-1.5 text-[11px] font-medium text-muted">Status</p>
          <Select value={status} onChange={(e) => setStatus(e.target.value as BugFeedbackStatus)} className="bg-card">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-[11px] font-medium text-muted">Admin notes (internal)</p>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="bg-card"
            placeholder="Triage notes…"
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:mb-0.5">
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]"
            disabled={busy}
            onClick={onDelete}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <Button type="button" className="rounded-full" disabled={busy} onClick={() => onSave(status, notes)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
