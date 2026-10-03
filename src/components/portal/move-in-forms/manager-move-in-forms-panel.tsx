"use client";

/**
 * Sidebar › Move-in: every move-in form residents have filled out (Submitted) or still owe
 * (Waiting), across properties. On the house list surface, copied from Properties/Inspections:
 * header tabs with counts, search, a Filter (Property, Form) and the one round + that sends a form
 * by hand. Rows are tile · "Resident · Form" · "Property · Room" · glyph facts · ⋯, with no pill;
 * a late form reads as plain red text.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, Camera, Clock, PenLine, Send, type LucideIcon } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MoveInFormViewer } from "@/components/portal/move-in-forms/move-in-form-viewer";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";
import { MoveInFormMenuItems, useMoveInFormRowActions } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  filterMoveInForms,
  moveInFormFacts,
  moveInFormFilterNames,
  moveInFormPlaceLine,
  moveInFormTabCounts,
  moveInFormTitle,
  type MoveInFormFact,
  type MoveInFormListTab,
} from "@/lib/move-in-forms/manager-rows";
import type { MoveInFormSummary } from "@/lib/move-in-forms/types";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  moveInFormListHref,
  propertyDetailHref,
  propertyListHref,
  MOVE_IN_FORM_LIST_TABS,
} from "@/lib/portal-detail-routes";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling } from "@/lib/portal-empty-copy";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

const TAB_LABELS: Record<MoveInFormListTab, string> = { submitted: "Submitted", waiting: "Waiting" };

const ALL = "all";

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

export function ManagerMoveInFormsPage({ tab = "submitted", basePath = "/portal" }: { tab?: MoveInFormListTab; basePath?: string }) {
  return (
    <ManagerPortalPageShell title="Move-in" hideTitleOnMobileNav compactFilterRow>
      <MoveInFormsPanel tab={tab} basePath={basePath} />
    </ManagerPortalPageShell>
  );
}

function MoveInFormsPanel({ tab, basePath }: { tab: MoveInFormListTab; basePath: string }) {
  const { userId, ready } = usePortalSession();
  if (!ready) {
    return <div role="status" aria-label="Loading move-in forms" className="space-y-3 p-4"><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /></div>;
  }
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view move-in forms.</p>;
  // Remount on a viewer change so another account never sees stale rows.
  return <MoveInFormsWorkspace key={userId ?? "demo"} userId={userId ?? "demo"} tab={tab} basePath={basePath} />;
}

function MoveInFormsWorkspace({ userId, tab, basePath }: { userId: string; tab: MoveInFormListTab; basePath: string }) {
  const navigate = usePortalNavigate();
  const actions = useMoveInFormRowActions();
  const { list, loading, error, retry } = useManagerMoveInForms(userId);
  const [query, setQuery] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [formName, setFormName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const demo = isDemoModeActive();

  const now = useMemo(() => new Date(), []);

  // The workspace narrows the list to its own houses, like every other list; tab counts are the
  // narrowed, unfiltered totals so the tab and the rows can never disagree.
  const scoped = useMemo(() => list.forms.filter((form) => workspaceContainsProperty(form.propertyId)), [list.forms]);
  const counts = useMemo(() => moveInFormTabCounts(scoped), [scoped]);
  const rows = useMemo(
    () => filterMoveInForms(scoped, { tab, propertyId, formName, query }, now),
    [scoped, tab, propertyId, formName, query, now],
  );
  const filtersActive = Boolean(propertyId || formName);
  const hasAny = counts.submitted + counts.waiting > 0;

  const propertyOptions = useMemo(() => {
    const options = new Map(buildManagerPropertyFilterOptions(userId).map((option) => [option.id, option.label]));
    for (const form of scoped) if (form.propertyId && !options.has(form.propertyId)) options.set(form.propertyId, form.propertyLabel);
    return [...options].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [userId, scoped]);
  const formNames = useMemo(() => moveInFormFilterNames(scoped), [scoped]);

  const tabs = MOVE_IN_FORM_LIST_TABS.map((id) => ({
    id,
    label: TAB_LABELS[id],
    count: counts[id],
    href: moveInFormListHref(basePath, id),
    dataAttr: `move-in-forms-tab-${id}`,
  }));

  const clearFilters = () => {
    setPropertyId("");
    setFormName("");
    setQuery("");
  };

  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };
  const selectedForm = selected.size === 1 ? scoped.find((form) => selected.has(form.id)) : undefined;

  const propertyLabel = propertyOptions.find((option) => option.id === propertyId)?.label ?? "";
  const emptyCard = !hasAny
    ? {
        title: "No move-in forms yet",
        section: "move-in",
        actions: demo ? [] : [{ label: "Make a move-in form", onClick: () => navigate(propertyListHref(basePath, "all")), dataAttr: "move-in-forms-empty-make" }],
      }
    : rows.length === 0 && (query.trim() || filtersActive)
      ? {
          title: portalEmptyNoMatchTitle("move-in forms", query),
          section: "move-in",
          tone: "muted" as const,
          clear: { label: filtersActive ? "Clear filters" : "Clear search", onClick: clearFilters, dataAttr: "move-in-forms-empty-clear" },
        }
      : {
          title: portalEmptyCopy(`move-in.${tab}`).title,
          section: "move-in",
          sibling: portalEmptySibling(tabs.map((t) => ({ id: t.id, label: t.label.toLowerCase(), count: t.count, href: t.href })), tab),
        };

  return (
    <div className="min-w-0 space-y-3" data-attr="move-in-forms-panel">
      <PortalListControlStack
        variant="command"
        stickyDestinations
        destinationAriaLabel="Move-in forms"
        activeDestinationId={tab}
        destinations={tabs}
        search={{ value: query, onChange: setQuery, placeholder: "Search move-in forms", dataAttr: "move-in-forms-search" }}
        actions={
          <PortalFilterSortSheet
            activeCount={portalFilterActiveCount([propertyId, formName])}
            compactPanel
            commandStripTrigger
            filterFieldCount={2}
            className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
            onReset={() => {
              setPropertyId("");
              setFormName("");
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
              label="Form"
              variant="cell"
              value={formName || ALL}
              onChange={(next) => setFormName(next === ALL ? "" : next)}
              options={[{ value: ALL, label: "All forms" }, ...formNames.map((name) => ({ value: name, label: name }))]}
              dataAttr="move-in-forms-filter-form"
            />
          </PortalFilterSortSheet>
        }
        primary={
          demo ? undefined : (
            <PortalPrimaryIconAction label="Send a form" data-attr="move-in-forms-send" onClick={() => setSendOpen(true)} />
          )
        }
        activeFilterChips={
          filtersActive ? (
            <PortalActiveFilterChips
              chips={[
                ...(propertyId ? [{ id: "property", label: `Property: ${propertyLabel || "Selected"}`, onRemove: () => setPropertyId("") }] : []),
                ...(formName ? [{ id: "form", label: `Form: ${formName}`, onRemove: () => setFormName("") }] : []),
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
