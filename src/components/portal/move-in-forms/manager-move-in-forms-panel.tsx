"use client";

/**
 * Sidebar › Move-in: one tab per form the manager has added to a property, grouped by form name
 * across properties (trimmed, case-insensitive), alphabetical. A form with no copies still has its
 * tab. Each tab lists every resident's copy of that form (sent and submitted together, cancelled
 * excluded; late first, then waiting by due date, then submitted newest first), on the house list
 * surface copied from Properties: tabs with counts, search, a Filter (Property, Status) and the one
 * round + that sends a form by hand. Rows are tile · "Resident · Form" · "Property · Room" · glyph
 * facts · ⋯, with no pill; a late form reads as plain red text. The tabs come from the property
 * store merged with the names on the loaded copies, so a renamed or deleted form's copies still show
 * under the name they were sent with. With no form anywhere the page is one empty state.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, Camera, Clock, PenLine, Send, type LucideIcon } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { DestinationNavItem } from "@/components/ui/destination-nav";
import { MoveInFormViewer } from "@/components/portal/move-in-forms/move-in-form-viewer";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";
import { MoveInFormMenuItems, useMoveInFormRowActions } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { usePortalSession } from "@/hooks/use-portal-session";
import { usePropertyPipelineTick } from "@/hooks/use-property-pipeline-tick";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { storedMoveInFormNames } from "@/lib/move-in-forms/manager-forms";
import {
  filterMoveInForms,
  moveInFormFacts,
  moveInFormPlaceLine,
  moveInFormTabCounts,
  moveInFormTabGroups,
  moveInFormTitle,
  type MoveInFormFact,
  type MoveInFormStatusBucket,
  type MoveInFormTabGroup,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormSummary } from "@/lib/move-in-forms/types";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { moveInFormListHref, propertyDetailHref, propertyListHref } from "@/lib/portal-detail-routes";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling } from "@/lib/portal-empty-copy";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

const ALL = "all";

const STATUS_LABELS: Record<MoveInFormStatusBucket, string> = { waiting: "Waiting", submitted: "Submitted" };

const FACT_ICON: Record<MoveInFormFact["id"], LucideIcon> = {
  submitted: CheckCircle2,
  signed: PenLine,
  photos: Camera,
  sent: Send,
  due: Clock,
};

/** Glyph facts for a row; a late due date is plain red text, never a chip. */
export function moveInFormEntryFacts(form: MoveInFormSummary, now: Date = new Date()): PortalEntryRowFact[] {
  return moveInFormFacts(form, now).map((fact) => ({
    icon: FACT_ICON[fact.id],
    label: fact.late ? <span className="font-medium text-[var(--status-overdue-fg)]">{fact.text}</span> : fact.text,
  }));
}

/** The page's tab row: one tab per form, each carrying its row count. */
export function moveInFormTabs(basePath: string, groups: readonly MoveInFormTabGroup[], counts: Record<string, number>): DestinationNavItem[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    count: counts[group.id] ?? 0,
    href: moveInFormListHref(basePath, group.id),
    dataAttr: `move-in-forms-tab-${group.id}`,
  }));
}

export function ManagerMoveInFormsPage({ tab, basePath = "/portal" }: { tab?: string; basePath?: string }) {
  return (
    <ManagerPortalPageShell title="Move-in" hideTitleOnMobileNav compactFilterRow>
      <MoveInFormsPanel tab={tab} basePath={basePath} />
    </ManagerPortalPageShell>
  );
}

function MoveInFormsPanel({ tab, basePath }: { tab?: string; basePath: string }) {
  const { userId, ready } = usePortalSession();
  if (!ready) {
    return <div role="status" aria-label="Loading move-in forms" className="space-y-3 p-4"><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /></div>;
  }
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view move-in forms.</p>;
  // Remount on a viewer change so another account never sees stale rows.
  return <MoveInFormsWorkspace key={userId ?? "demo"} userId={userId ?? "demo"} tab={tab} basePath={basePath} />;
}

function MoveInFormsWorkspace({ userId, tab, basePath }: { userId: string; tab?: string; basePath: string }) {
  const navigate = usePortalNavigate();
  const actions = useMoveInFormRowActions();
  const { list, loading, error, retry } = useManagerMoveInForms(userId);
  const [query, setQuery] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [status, setStatus] = useState<MoveInFormStatusBucket | "">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const demo = isDemoModeActive();

  const now = useMemo(() => new Date(), []);

  // The workspace narrows the list to its own houses, like every other list; tab counts are the
  // narrowed, unfiltered totals so the tab and the rows can never disagree.
  const scoped = useMemo(() => list.forms.filter((form) => workspaceContainsProperty(form.propertyId)), [list.forms]);
  const propertyTick = usePropertyPipelineTick();
  const groups = useMemo(() => {
    void propertyTick; // the property store changed: read the forms again
    return moveInFormTabGroups(storedMoveInFormNames(userId), scoped);
  }, [userId, scoped, propertyTick]);
  const counts = useMemo(() => moveInFormTabCounts(groups, scoped), [groups, scoped]);
  // The bare address, and a slug that matches no form, show the first tab.
  const active = groups.find((group) => group.id === tab) ?? groups[0] ?? null;
  const rows = useMemo(
    () => (active ? filterMoveInForms(scoped, { formName: active.label, propertyId, status: status || undefined, query }, now) : []),
    [scoped, active, propertyId, status, query, now],
  );
  const filtersActive = Boolean(propertyId || status);
  const hasAny = active ? (counts[active.id] ?? 0) > 0 : false;

  const propertyOptions = useMemo(() => {
    const options = new Map(buildManagerPropertyFilterOptions(userId).map((option) => [option.id, option.label]));
    for (const form of scoped) if (form.propertyId && !options.has(form.propertyId)) options.set(form.propertyId, form.propertyLabel);
    return [...options].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [userId, scoped]);
  const tabs = moveInFormTabs(basePath, groups, counts);

  const clearFilters = () => {
    setPropertyId("");
    setStatus("");
    setQuery("");
  };

  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };
  const selectedForm = selected.size === 1 ? scoped.find((form) => selected.has(form.id)) : undefined;

  const propertyLabel = propertyOptions.find((option) => option.id === propertyId)?.label ?? "";
  const emptyCard = !active
    ? {
        title: portalEmptyCopy("move-in.forms").title,
        section: "move-in",
        actions: demo ? [] : [{ label: "Add form", onClick: () => navigate(propertyListHref(basePath, "all")), dataAttr: "move-in-forms-empty-add" }],
      }
    : !hasAny
      ? {
          title: portalEmptyCopy("move-in.copies").title,
          section: "move-in",
          sibling: portalEmptySibling(tabs.map((t) => ({ id: t.id, label: t.label.toLowerCase(), count: t.count ?? 0, href: t.href })), active.id),
        }
      : rows.length === 0 && (query.trim() || filtersActive)
        ? {
            title: portalEmptyNoMatchTitle("move-in forms", query),
            section: "move-in",
            tone: "muted" as const,
            clear: { label: filtersActive ? "Clear filters" : "Clear search", onClick: clearFilters, dataAttr: "move-in-forms-empty-clear" },
          }
        : {
            title: portalEmptyCopy("move-in.copies").title,
            section: "move-in",
            sibling: portalEmptySibling(tabs.map((t) => ({ id: t.id, label: t.label.toLowerCase(), count: t.count ?? 0, href: t.href })), active.id),
          };

  if (!active) {
    return (
      <div className="min-w-0 space-y-3" data-attr="move-in-forms-panel">
        <PortalRecordListSurface
          isEmpty
          loading={loading}
          loadError={error ? "Couldn't load move-in forms" : undefined}
          onRetry={retry}
          emptyCard={emptyCard}
          dataAttr="move-in-forms-list"
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3" data-attr="move-in-forms-panel">
      <PortalListControlStack
        variant="command"
        stickyDestinations
        destinationAriaLabel="Move-in forms"
        activeDestinationId={active.id}
        destinations={tabs}
        search={{ value: query, onChange: setQuery, placeholder: "Search move-in forms", dataAttr: "move-in-forms-search" }}
        actions={
          <PortalFilterSortSheet
            activeCount={portalFilterActiveCount([propertyId, status])}
            compactPanel
            commandStripTrigger
            filterFieldCount={2}
            className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
            onReset={() => {
              setPropertyId("");
              setStatus("");
            }}
            dataAttr="move-in-forms-filter-open"
          >
            <FieldSingleSelect
              label="Property"
              variant="cell"
              value={propertyId || ALL}
              onChange={(next) => setPropertyId(next === ALL ? "" : next)}
              options={[{ value: ALL, label: "All properties" }, ...propertyOptions.map((o) => ({ value: o.id, label: o.label }))]}
              dataAttr="move-in-forms-filter-property"
            />
            <FieldSingleSelect
              label="Status"
              variant="cell"
              value={status || ALL}
              onChange={(next) => setStatus(next === ALL ? "" : (next as MoveInFormStatusBucket))}
              options={[{ value: ALL, label: "All statuses" }, ...(Object.keys(STATUS_LABELS) as MoveInFormStatusBucket[]).map((id) => ({ value: id, label: STATUS_LABELS[id] }))]}
              dataAttr="move-in-forms-filter-status"
            />
          </PortalFilterSortSheet>
        }
        primary={
          demo ? undefined : (
            <PortalPrimaryIconAction label={portalListAddPrimaryLabel("move-in form")} data-attr="move-in-forms-send" onClick={() => setSendOpen(true)} />
          )
        }
        activeFilterChips={
          filtersActive ? (
            <PortalActiveFilterChips
              chips={[
                ...(propertyId ? [{ id: "property", label: `Property: ${propertyLabel || "Selected"}`, onRemove: () => setPropertyId("") }] : []),
                ...(status ? [{ id: "status", label: `Status: ${STATUS_LABELS[status]}`, onRemove: () => setStatus("") }] : []),
              ]}
            />
          ) : null
        }
      />
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        loading={loading}
        loadError={error ? "Couldn't load move-in forms" : undefined}
        onRetry={retry}
        emptyCard={emptyCard}
        onBulkClear={() => setSelected(new Set())}
        bulkCount={selected.size}
        bulkActions={
          selectedForm ? (
            <PortalSectionActionRow variant="header">
              <MoveInFormMenuItems form={selectedForm} actions={actions} onOpen={open} />
            </PortalSectionActionRow>
          ) : undefined
        }
        dataAttr="move-in-forms-list"
      >
        {rows.map((form) => (
          <PortalEntryRow
            key={form.id}
            tile={{ kind: "initials", label: form.residentName }}
            title={moveInFormTitle(form)}
            place={moveInFormPlaceLine(form)}
            facts={moveInFormEntryFacts(form, now)}
            checked={selected.has(form.id)}
            onSelectedChange={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(form.id);
                else next.delete(form.id);
                return next;
              })
            }
            onOpen={() => open(form)}
            omitActionView
            selectLabel={moveInFormTitle(form)}
            dataAttr="move-in-form-row"
          />
        ))}
      </PortalRecordListSurface>
      {viewing ? <MoveInFormViewer form={viewing} actions={actions} onClose={() => setViewing(null)} /> : null}
      {sendOpen ? (
        <SendMoveInFormPopup
          userId={userId}
          onClose={() => setSendOpen(false)}
          onOpenProperty={(id) => {
            setSendOpen(false);
            navigate(propertyDetailHref(basePath, "all", id, "move-in"));
          }}
        />
      ) : null}
    </div>
  );
}
