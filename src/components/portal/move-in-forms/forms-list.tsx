"use client";

/**
 * The Forms list: every form sent to a resident, on the house list surface copied from Properties.
 * Header card with Pending · Completed underline tabs (counts), search, a Filter popover (Kind,
 * Property, Resident, Blocks) and the round blue + that sends a form. Rows are tile · form name ·
 * "resident · property · room" · glyph facts (what it blocks, due or submitted date) · the row's ⋯
 * (pending: Edit · Remind · Cancel request; completed: View · Download PDF). No pill on a row; a late
 * date is plain red text. Pending is `sent`, Completed is `submitted`; cancelled copies never list.
 *
 * It draws two ways from one component: the sidebar page (every resident) and the manager resident
 * record's Forms tab (`applicationId` set: that resident only, so no Resident or Property filter and
 * no resident in the place line).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Lock, Unlock, Clock, CheckCircle2, type LucideIcon } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import type { DestinationNavItem } from "@/components/ui/destination-nav";
import { Button } from "@/components/ui/button";
import { MoveInFormViewer } from "@/components/portal/move-in-forms/move-in-form-viewer";
import { SendMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-send-popup";
import { EditPendingMoveInFormPopup } from "@/components/portal/move-in-forms/move-in-form-edit-pending-popup";
import { useMoveInFormRowActions, type MoveInFormRowActionHandlers } from "@/components/portal/move-in-forms/move-in-form-row-actions";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useManagerMoveInForms } from "@/hooks/use-move-in-forms";
import { track } from "@/lib/analytics/track-client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  filterFormsList,
  formsBlocksFact,
  formsBucketCounts,
  formsDateFact,
  moveInFormPlaceLine,
  MOVE_IN_FORM_KIND_LABELS,
  type FormsListBucket,
} from "@/lib/move-in-forms/manager-rows";
import {
  MOVE_IN_FORM_BLOCKS,
  MOVE_IN_FORM_BLOCKS_LABELS,
  resolveMoveInFormBlocks,
  type MoveInFormBlocks,
  type MoveInFormKind,
  type MoveInFormSummary,
} from "@/lib/move-in-forms/types";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { formsListHref, parseFormsBucket, propertyDetailHref } from "@/lib/portal-detail-routes";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

const BUCKET_LABELS: Record<FormsListBucket, string> = { pending: "Pending", completed: "Completed" };
const KINDS: readonly MoveInFormKind[] = ["intake", "move-in", "move-out", "other"];

/** Glyph facts for a row: what it blocks, then its due or submitted date (a late due date is plain red text). */
export function formsEntryFacts(form: MoveInFormSummary, now: Date = new Date()): PortalEntryRowFact[] {
  const blocking = resolveMoveInFormBlocks(form.blocks, form.kind) !== "nothing";
  const date = formsDateFact(form, now);
  const DateIcon: LucideIcon = form.status === "submitted" ? CheckCircle2 : Clock;
  return [
    { icon: blocking ? Lock : Unlock, label: formsBlocksFact(form) },
    { icon: DateIcon, label: date.late ? <span className="font-medium text-[var(--status-overdue-fg)]">{date.text}</span> : date.text },
  ];
}

/**
 * The ⋯ leaves for one row, in the plan's order; a destructive action is last. Called as a function (not
 * mounted as a component) so the record menu sees the leaves themselves and draws them as menu items.
 */
export function formsRowMenuItems({
  form,
  actions,
  onEdit,
  onView,
}: {
  form: MoveInFormSummary;
  actions: MoveInFormRowActionHandlers;
  onEdit: (form: MoveInFormSummary) => void;
  onView: (form: MoveInFormSummary) => void;
}): ReactNode {
  const item = (label: string, dataAttr: string, onClick: () => void | Promise<unknown>, variant: "outline" | "danger" = "outline") => (
    <Button key={dataAttr} type="button" variant={variant} className={PORTAL_BULK_BAR_BTN} data-attr={dataAttr} onClick={onClick}>
      {label}
    </Button>
  );
  if (form.status === "submitted") {
    return (
      <>
        {item("View", "forms-row-view", () => onView(form))}
        {item("Download PDF", "forms-row-download", () => actions.download(form))}
      </>
    );
  }
  return (
    <>
      {item("Edit", "forms-row-edit", () => onEdit(form))}
      {item("Remind", "forms-row-remind", () => actions.remind(form))}
      {item("Cancel request", "forms-row-cancel", () => actions.cancel(form), "danger")}
    </>
  );
}

export function ManagerFormsPage({ tab, basePath = "/portal" }: { tab?: string; basePath?: string }) {
  return (
    <ManagerPortalPageShell title="Forms" hideTitleOnMobileNav compactFilterRow>
      <FormsGate bucket={parseFormsBucket(tab) ?? "pending"} basePath={basePath} />
    </ManagerPortalPageShell>
  );
}

function FormsGate({ bucket, basePath }: { bucket: FormsListBucket; basePath: string }) {
  const { userId, ready } = usePortalSession();
  if (!ready) {
    return (
      <div role="status" aria-label="Loading forms" className="space-y-3 p-4">
        <div className="h-16 animate-pulse rounded-xl bg-foreground/5" />
        <div className="h-16 animate-pulse rounded-xl bg-foreground/5" />
      </div>
    );
  }
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view forms.</p>;
  // Remount on a viewer change so another account never sees stale rows.
  return <FormsList key={userId ?? "demo"} userId={userId ?? "demo"} bucket={bucket} basePath={basePath} />;
}

export function FormsList({
  userId,
  bucket,
  basePath,
  applicationId,
  bucketHref,
  className,
}: {
  userId: string;
  bucket: FormsListBucket;
  basePath: string;
  /** Set on a resident record: that resident's forms only. */
  applicationId?: string;
  /** Where each tab goes. Defaults to the sidebar page's addresses. */
  bucketHref?: (bucket: FormsListBucket) => string;
  className?: string;
}) {
  const navigate = usePortalNavigate();
  const actions = useMoveInFormRowActions();
  const { list, loading, error, retry } = useManagerMoveInForms(userId, applicationId ? { applicationId } : {});
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [residentIds, setResidentIds] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<MoveInFormSummary | null>(null);
  const [editing, setEditing] = useState<MoveInFormSummary | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const demo = isDemoModeActive();
  const scopedToResident = Boolean(applicationId);
  // A due date passes while the tab sits open. Without this tick `now` froze at mount, so a form went
  // on reading "Due Oct 12" (and sorting as not-late) here while the resident's own list, which
  // recomputes every render, already called it late.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  // The workspace narrows the list to its own houses, like every other list; the tab counts are the
  // narrowed, unfiltered totals so a tab and its rows can never disagree.
  const scoped = useMemo(
    () => list.forms.filter((form) => (!applicationId || form.applicationId === applicationId) && workspaceContainsProperty(form.propertyId)),
    [list.forms, applicationId],
  );
  const counts = useMemo(() => formsBucketCounts(scoped), [scoped]);
  const rows = useMemo(
    () =>
      filterFormsList(
        scoped,
        {
          bucket,
          query,
          kinds: kinds as MoveInFormKind[],
          propertyIds,
          residentIds,
          blocks: blocks as MoveInFormBlocks[],
        },
        now,
      ),
    [scoped, bucket, query, kinds, propertyIds, residentIds, blocks, now],
  );
  const filtersActive = kinds.length + propertyIds.length + residentIds.length + blocks.length > 0;

  const propertyOptions = useMemo(() => {
    const options = new Map(buildManagerPropertyFilterOptions(userId).map((option) => [option.id, option.label]));
    for (const form of scoped) if (form.propertyId && !options.has(form.propertyId)) options.set(form.propertyId, form.propertyLabel);
    return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [userId, scoped]);
  const residentOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const form of scoped) options.set(form.applicationId, form.residentName.trim() || "Resident");
    return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [scoped]);

  const hrefFor = bucketHref ?? ((next: FormsListBucket) => formsListHref(basePath, next));
  const tabs: DestinationNavItem[] = (["pending", "completed"] as const).map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    count: counts[id],
    href: hrefFor(id),
    dataAttr: `forms-tab-${id}`,
  }));

  const clearFilters = () => {
    setKinds([]);
    setPropertyIds([]);
    setResidentIds([]);
    setBlocks([]);
    setQuery("");
  };
  const open = (form: MoveInFormSummary) => {
    track("move_in_form_opened", { status: form.status });
    setViewing(form);
  };
  const edit = (form: MoveInFormSummary) => {
    track("move_in_form_edit_opened", { status: form.status });
    setEditing(form);
  };
  const selectedForm = selected.size === 1 ? scoped.find((form) => selected.has(form.id)) : undefined;

  const bucketHasAny = counts[bucket] > 0;
  const emptyCard =
    rows.length === 0 && bucketHasAny && (query.trim() || filtersActive)
      ? {
          title: portalEmptyNoMatchTitle("forms", query),
          section: "forms",
          tone: "muted" as const,
          clear: { label: filtersActive ? "Clear filters" : "Clear search", onClick: clearFilters, dataAttr: "forms-empty-clear" },
        }
      : { title: portalEmptyCopy(bucket === "pending" ? "forms.pending" : "forms.completed").title, section: "forms" };

  const filterFields = (
    <>
      <CheckboxMultiSelect
        label="Kind"
        variant="cell"
        options={KINDS.map((id) => ({ value: id, label: MOVE_IN_FORM_KIND_LABELS[id] }))}
        selected={kinds}
        onChange={setKinds}
        emptyLabel="All kinds"
        dataAttr="forms-filter-kind"
      />
      {scopedToResident ? null : (
        <CheckboxMultiSelect
          label="Property"
          variant="cell"
          options={propertyOptions}
          selected={propertyIds}
          onChange={setPropertyIds}
          emptyLabel="All properties"
          dataAttr="forms-filter-property"
        />
      )}
      {scopedToResident ? null : (
        <CheckboxMultiSelect
          label="Resident"
          variant="cell"
          options={residentOptions}
          selected={residentIds}
          onChange={setResidentIds}
          emptyLabel="All residents"
          dataAttr="forms-filter-resident"
        />
      )}
      <CheckboxMultiSelect
        label="Blocks"
        variant="cell"
        options={MOVE_IN_FORM_BLOCKS.map((id) => ({ value: id, label: MOVE_IN_FORM_BLOCKS_LABELS[id] }))}
        selected={blocks}
        onChange={setBlocks}
        emptyLabel="Anything"
        dataAttr="forms-filter-blocks"
      />
    </>
  );

  return (
    <div className={className ?? "min-w-0 space-y-3"} data-attr="forms-list-panel" data-forms-bucket={bucket}>
      <PortalListControlStack
        variant="command"
        className={scopedToResident ? "rs40 mb-2 max-lg:mb-1.5 plp-header-card" : undefined}
        stickyDestinations={!scopedToResident}
        destinationAriaLabel="Forms"
        activeDestinationId={bucket}
        destinations={tabs}
        search={{ value: query, onChange: setQuery, placeholder: "Search forms", dataAttr: "forms-search" }}
        actions={
          <PortalFilterSortSheet
            activeCount={portalFilterActiveCount([kinds, propertyIds, residentIds, blocks])}
            compactPanel
            commandStripTrigger
            filterFieldCount={scopedToResident ? 2 : 4}
            className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
            onReset={() => {
              setKinds([]);
              setPropertyIds([]);
              setResidentIds([]);
              setBlocks([]);
            }}
            dataAttr="forms-filter-open"
          >
            {filterFields}
          </PortalFilterSortSheet>
        }
        primary={
          // A form is sent to be filled in, so on a resident's record the + belongs to Pending only.
          demo || (scopedToResident && bucket === "completed") ? undefined : (
            <PortalPrimaryIconAction label={portalListAddPrimaryLabel("form")} data-attr="forms-send" onClick={() => setSendOpen(true)} />
          )
        }
      />
      <PortalListGroupRowContext.Provider value={scopedToResident}>
        <PortalRecordListSurface
          isEmpty={rows.length === 0}
          loading={loading}
          loadError={error ? "Couldn't load forms" : undefined}
          onRetry={retry}
          emptyCard={emptyCard}
          onBulkClear={() => setSelected(new Set())}
          bulkCount={selected.size}
          bulkActions={selectedForm ? formsRowMenuItems({ form: selectedForm, actions, onEdit: edit, onView: open }) : undefined}
          dataAttr="forms-list"
        >
          {rows.map((form) => (
            <PortalEntryRow
              key={form.id}
              tile={scopedToResident ? { kind: "glyph", icon: FileText } : { kind: "initials", label: form.residentName }}
              title={form.formName}
              place={scopedToResident ? moveInFormPlaceLine(form) : [form.residentName.trim() || "Resident", moveInFormPlaceLine(form)].filter(Boolean).join(" · ")}
              facts={formsEntryFacts(form, now)}
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
              selectLabel={form.formName}
              dataAttr="forms-row"
            />
          ))}
        </PortalRecordListSurface>
      </PortalListGroupRowContext.Provider>
      {viewing ? <MoveInFormViewer form={viewing} actions={actions} onClose={() => setViewing(null)} /> : null}
      {editing ? <EditPendingMoveInFormPopup form={editing} onClose={() => setEditing(null)} /> : null}
      {sendOpen ? (
        <SendMoveInFormPopup
          userId={userId}
          presetApplicationId={applicationId}
          onClose={() => setSendOpen(false)}
          onOpenProperty={(id) => {
            setSendOpen(false);
            navigate(propertyDetailHref(basePath, "all", id, "forms"));
          }}
        />
      ) : null}
    </div>
  );
}

/** The resident record's Forms tab: the same list, that resident's forms only. */
export function ResidentRecordForms({
  userId,
  applicationId,
  bucket,
  basePath,
  bucketHref,
}: {
  userId: string;
  applicationId: string;
  bucket: FormsListBucket;
  basePath: string;
  bucketHref: (bucket: FormsListBucket) => string;
}) {
  return (
    <FormsList
      userId={userId}
      applicationId={applicationId}
      bucket={bucket}
      basePath={basePath}
      bucketHref={bucketHref}
      className="min-w-0"
    />
  );
}
