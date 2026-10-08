"use client";

/**
 * The operations tabs' pop-ups and record pages for the home demo (Tasks, Bookings, Promotion, Outgoing payments,
 * Finances, Documents), drawn from the real portal's exported pieces with fixture props. Loaded on demand
 * (`demo-popups-lazy-ops.tsx`).
 *
 *  - Pop-ups are the real house workspace (`demo-popup.tsx`) with each door's real title, step rail, field labels and
 *    footer words: Add task, Add booking, New promotion, Add payment, Add expense / Add income, Upload document.
 *  - Small centred dialogs (the booking day, the promotion view, Financial entry, Pay vendor, ...) are drawn by
 *    `DemoSmallDialog`, because the real `PortalDialog` / `Modal` portals to the browser body and mounts the assistant.
 *  - Record pages are `DemoRecordPage` with the real rail and header icons from `recordSections(...)`.
 *
 * Nothing here fetches or saves: a primary button only closes the pop-up and the panel toasts "(sample)".
 */

import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Download, FileText, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Select, Textarea } from "@/components/ui/input";
import {
  MODAL_FIELD_LABEL_CLASS,
  MODAL_HEADER_CLOSE_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
import { SegmentedThree } from "@/components/ui/segmented-control";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { RecordRowsCard, type RecordRowItem } from "@/components/portal/portal-record-overview-kit";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { PromotionTextPreview } from "@/components/portal/promotion-text-preview";
import { PromotionFlyerPreview } from "@/components/portal/promotion-flyer-preview";
import { PROMOTION_UPLOAD_ACCEPT } from "@/components/portal/promotion-upload-composer";
import { TemplateThumb, EMPTY_DRAFT, draftToPreviewRow, type PromotionDraft } from "@/components/portal/promotion-form";
import { ExpenseTaxStatusToggle } from "@/components/portal/expense-tax-status-toggle";
import { DOCUMENT_FILE_CHIPS, WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { DOCUMENT_UPLOAD_ACCEPT } from "@/lib/documents/manager-documents";
import {
  PreviewPanel,
  WizardField,
  WizardLine,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { recordSections } from "@/lib/portals/record-sections";
import {
  PROMOTION_TEMPLATE_OPTIONS,
  PROMOTION_SIZE_OPTIONS,
  PROMOTION_THEME_OPTIONS,
  PROMOTION_TONE_OPTIONS,
  type PromotionTemplate,
} from "@/lib/promotion-flyer";
import { PROMOTION_TEXT_FORMAT_OPTIONS, type PromotionTextFormat } from "@/lib/promotion-text";
import { SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";
import { OUTGOING_PAYMENT_CATEGORY_CODES } from "@/lib/manager-outgoing-payments";
import { PAYEE_TYPE_LABEL, PAY_METHOD_LABEL, PICKABLE_PAYEE_TYPES, PAY_METHODS, TEAMMATE_PAYMENT_REASONS } from "@/lib/manager-payees";
import { cn } from "@/lib/utils";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";
import { DemoWorkspacePopup } from "@/components/marketing/site/product-mock/demo-popup";
import { DemoRecordPage, DemoRecordThread, RecordFactCard, RecordFactRow, type DemoRecordAction } from "@/components/marketing/site/product-mock/demo-record";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import type {
  BookingFixtureRow,
  DocumentFixtureRow,
  OutgoingFixtureRow,
  PromotionFixtureRow,
  TaskFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures-more";
import {
  OPS_ASSIGNEES,
  OPS_BOOKING_DETAILS,
  OPS_BOOKING_SOURCES,
  OPS_DOCUMENT_CATEGORIES,
  OPS_DOCUMENT_VISIBILITY,
  OPS_HOUSES,
  OPS_NEW_TASK,
  OPS_OTHER_DOCUMENTS,
  OPS_OUTGOING_DETAILS,
  OPS_PAYEES,
  OPS_PAY_VENDORS,
  OPS_PROMOTION_DETAILS,
  OPS_PROMOTION_PROPERTIES,
  OPS_RESIDENTS,
  OPS_APPLICATION_DOCS,
  OPS_TASK_DETAILS,
  OPS_TASK_KIND_OPTIONS,
  OPS_TEAMMATES,
  type OpsReport,
  type OpsTaskDetail,
} from "@/components/marketing/site/product-mock/fixtures-popups-ops";

/* ───────────────────────────── small shared pieces ───────────────────────────── */

const toOptions = (rows: readonly string[]) => rows.map((value) => ({ value, label: value }));

/** A small centred dialog inside the demo window: title, header action, ×, body, footer buttons at the right. */
export function DemoSmallDialog({
  title,
  onClose,
  headerAction,
  footer,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const host = useContext(DemoPopupHostContext);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const layer = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-demo-popup=""
      className="demo-popup-layer pointer-events-auto absolute inset-0 z-[40] flex min-h-0 min-w-0 items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
    >
      <div
        className={cn(
          "flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_70px_-30px_rgba(15,23,42,0.5)]",
          wide ? "max-w-[760px]" : "max-w-[520px]",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold text-foreground">{title}</h2>
          {headerAction}
          <button type="button" aria-label="Close" onClick={onClose} className={MODAL_HEADER_CLOSE_CLASS}>
            <X className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
  return host ? createPortal(layer, host) : layer;
}

function PrimaryButton({ children, onClick, danger = false }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <Button type="button" variant={danger ? "danger" : "primary"} className="rounded-full" data-demo-target="sheet-primary" onClick={onClick}>
      {children}
    </Button>
  );
}

/** The real `ConfirmRows`: label left, value right, hairlines between. */
function ConfirmRows({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="divide-y divide-border/70 text-sm" data-attr="portal-dialog-confirm-rows">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-muted">{row.label}</dt>
          <dd className="min-w-0 text-right font-medium text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A confirm for a destructive act: a danger primary, no Cancel (the header x dismisses). */
export function DemoConfirmDialog({ title, body, confirmLabel, onClose, onConfirm }: { title: string; body: string; confirmLabel: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <DemoSmallDialog title={title} onClose={onClose} footer={<PrimaryButton danger onClick={onConfirm}>{confirmLabel}</PrimaryButton>}>
      <p className="text-sm text-foreground">{body}</p>
    </DemoSmallDialog>
  );
}

/** One labelled field in a popup form grid, with the real modal label class. */
function Field({ label, htmlFor, full = false, children }: { label: string; htmlFor?: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, full && PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
      <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Pick({
  id,
  label,
  value,
  onChange,
  options,
  full = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  full?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} full={full}>
      <Select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function Text({
  id,
  label,
  value,
  onChange,
  type = "text",
  full = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  full?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label} htmlFor={id} full={full}>
      <Input id={id} type={type} className={type === "date" ? "portal-modal-date-input" : undefined} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

const ReviewList = ({ rows }: { rows: Array<[string, string]> }) => (
  <dl className="divide-y divide-border">
    {rows.map(([label, value]) => (
      <div key={label} className="flex items-start justify-between gap-4 py-3">
        <dt className="text-sm text-muted">{label}</dt>
        <dd className="text-right text-sm font-semibold text-foreground">{value || "—"}</dd>
      </div>
    ))}
  </dl>
);

const houseLabel = (id: string) => OPS_HOUSES.find((h) => h.id === id)?.label ?? "";
const houseOptions = (empty: string) => [{ value: "", label: empty }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))];
const longDate = (iso: string) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

/** The record's thread, or the real empty card when nobody has written yet. */
function RecordCommunication({ name, subtitle, messages, onSent }: { name: string; subtitle?: string; messages: { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" }[]; onSent: () => void }) {
  if (!name) return <PortalListEmptyCard title="No messages yet" section="communication" workspaceAware={false} />;
  return <DemoRecordThread name={name} subtitle={subtitle} messages={messages} selfName="Manager" onSent={onSent} />;
}

/* ═════════════════════════════════ TASKS ═════════════════════════════════ */

const TIMING_OPTIONS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "urgent", label: "As needed" },
  { value: "deadline", label: "Deadline" },
];
const PRIORITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const DURATION_OPTIONS = [
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
];
const WORK_ORDER_CATEGORIES = ["Plumbing", "Electrical", "HVAC", "Appliance", "Access / Locks", "General"];
const REPEAT_OPTIONS = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month (same day, month-end clamped)" },
];
const assigneeLabel = (value: string) => OPS_ASSIGNEES.find((a) => a.value === value)?.label ?? "No one yet";

/** Add task / Edit task: the real `ManagerTaskFormModal`'s four steps and fields. */
export function DemoTaskFormPopup({ mode, task, onClose, onSaved }: { mode: "add" | "edit"; task?: OpsTaskDetail; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(() => ({
    ...(task ?? OPS_NEW_TASK),
    category: "General",
    guestName: "",
    guestEmail: "",
    guestPhone: "",
    duration: "60",
    repeats: "none",
  }));
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const isTour = form.kind === "tour";
  const isService = form.kind === "service";
  const propertyRequired = form.kind !== "general";
  const house = OPS_HOUSES.find((h) => h.id === form.houseId);
  const residents = OPS_RESIDENTS.filter((r) => !form.houseId || r.houseId === form.houseId);
  const steps = [
    { id: "task", label: "Task", summary: form.description.trim() || form.guestName.trim() || "What to do" },
    { id: "property", label: "Property", summary: house?.label || (propertyRequired ? "Pick a house" : "Optional") },
    { id: "when", label: "When", summary: form.scheduleDate || form.dueDate || (form.timing === "urgent" ? "As needed" : "Timing") },
    { id: "review", label: "Review", summary: mode === "edit" ? "Save task" : "Add task" },
  ];
  return (
    <DemoWorkspacePopup
      title={mode === "edit" ? "Edit task" : "Add task"}
      steps={steps}
      sidePanel={
        <PreviewPanel
          title="Task preview"
          name={form.description || "Untitled task"}
          facts={[
            { label: "Property", value: house?.label || "Not set" },
            { label: "Type", value: OPS_TASK_KIND_OPTIONS.find((k) => k.value === form.kind)?.label ?? "General" },
          ]}
          creates={[]}
        />
      }
      footer={{ kind: "wizard", lastLabel: mode === "edit" ? "Save task" : "Add task", onFinish: onSaved }}
      onClose={onClose}
      stepHeading=""
      dataAttr="manager-task-popup"
    >
      {(step) =>
        step === 0 ? (
          <div className="space-y-4">
            <Pick id="manager-task-kind" label="Task type" value={form.kind} onChange={(kind) => set({ kind: kind as OpsTaskDetail["kind"] })} options={OPS_TASK_KIND_OPTIONS} />
            <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
              {isTour ? (
                <>
                  <Text id="manager-task-guest-name" label="Guest name" value={form.guestName} onChange={(guestName) => set({ guestName })} placeholder="Jane Smith" />
                  <Text id="manager-task-guest-email" label="Guest email (optional)" type="email" value={form.guestEmail} onChange={(guestEmail) => set({ guestEmail })} placeholder="jane@example.com" />
                  <Text id="manager-task-guest-phone" label="Guest phone (optional)" type="tel" value={form.guestPhone} onChange={(guestPhone) => set({ guestPhone })} full />
                </>
              ) : (
                <Text
                  id="manager-task-title"
                  label={isService ? "Task title" : "Description"}
                  value={form.description}
                  onChange={(description) => set({ description })}
                  full
                  placeholder={isService ? "Leaky faucet in kitchen" : "Inspect unit, meet vendor, follow up…"}
                />
              )}
              <Pick id="manager-task-assignee" label="Assignee" value={form.assignee} onChange={(assignee) => set({ assignee })} options={OPS_ASSIGNEES} full />
            </div>
          </div>
        ) : step === 1 ? (
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            <Pick
              id="manager-task-property"
              label={propertyRequired ? "Property" : "Property (optional)"}
              value={form.houseId}
              onChange={(houseId) => set({ houseId, room: "", residentId: "" })}
              options={houseOptions(propertyRequired ? "Select property" : "No property")}
              full
            />
            {isService ? <Pick id="manager-task-work-order-category" label="Category" value={form.category} onChange={(category) => set({ category })} options={toOptions(WORK_ORDER_CATEGORIES)} full /> : null}
            {isService || form.kind === "move-in" || form.kind === "move-out" ? (
              <Pick
                id="manager-task-resident"
                label={isService ? "Resident" : "Resident (optional)"}
                value={form.residentId}
                onChange={(residentId) => set({ residentId })}
                options={[{ value: "", label: "Select resident" }, ...residents.map((r) => ({ value: r.id, label: `${r.name} · ${houseLabel(r.houseId)}` }))]}
                full
              />
            ) : null}
            {form.houseId ? (
              <Pick
                id="manager-task-room"
                label="Room (optional)"
                value={form.room}
                onChange={(room) => set({ room })}
                options={[{ value: "", label: "No room" }, ...(house?.rooms ?? []).map((room) => ({ value: room, label: room }))]}
                full
              />
            ) : null}
          </div>
        ) : step === 2 ? (
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            {isTour ? (
              <>
                <Text id="manager-task-schedule-date" label="Schedule date" type="date" value={form.scheduleDate} onChange={(scheduleDate) => set({ scheduleDate })} />
                <Text id="manager-task-tour-start-time" label="Start time" type="time" value={form.startTime} onChange={(startTime) => set({ startTime })} />
                <Pick id="manager-task-duration" label="Duration" value={form.duration} onChange={(duration) => set({ duration })} options={DURATION_OPTIONS} />
              </>
            ) : (
              <>
                <Pick id="manager-task-urgency" label="Timing" value={form.timing} onChange={(timing) => set({ timing: timing as OpsTaskDetail["timing"] })} options={TIMING_OPTIONS} />
                <Pick id="manager-task-priority" label="Priority" value={form.priority} onChange={(priority) => set({ priority: priority as OpsTaskDetail["priority"] })} options={PRIORITY_OPTIONS} />
                {form.timing === "deadline" ? <Text id="manager-task-due-date" label="Due date" type="date" value={form.dueDate} onChange={(dueDate) => set({ dueDate })} /> : null}
                {form.timing === "scheduled" ? (
                  <Field label="Schedule" full>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:grid-cols-[1.25fr_1fr_auto_1fr]">
                      <Input type="date" aria-label="Schedule date" className="portal-modal-date-input col-span-3 min-w-0 sm:col-span-1" value={form.scheduleDate} onChange={(e) => set({ scheduleDate: e.target.value })} />
                      <Input type="time" aria-label="Start time" className="min-w-0" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} />
                      <span aria-hidden="true" className="text-sm text-muted">–</span>
                      <Input type="time" aria-label="End time" className="min-w-0" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} />
                    </div>
                  </Field>
                ) : null}
                <Pick id="manager-task-recurrence" label="Repeats" value={form.repeats} onChange={(repeats) => set({ repeats })} options={REPEAT_OPTIONS} />
              </>
            )}
          </div>
        ) : (
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            <Field label="Notes (optional)" htmlFor="manager-task-notes" full>
              <Textarea id="manager-task-notes" className="min-h-[88px]" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            <Field label="Checklist (one step per line)" htmlFor="manager-task-checklist" full>
              <Textarea id="manager-task-checklist" className="min-h-[72px]" placeholder={"Check the filter\nPhotograph the unit"} value={form.checklist} onChange={(e) => set({ checklist: e.target.value })} />
            </Field>
            <Field label="Attachments (one link per line, optional name first)" htmlFor="manager-task-attachments" full>
              <Textarea id="manager-task-attachments" className="min-h-[56px]" placeholder={"Quote https://example.com/quote.pdf"} value={form.attachments} onChange={(e) => set({ attachments: e.target.value })} />
            </Field>
          </div>
        )
      }
    </DemoWorkspacePopup>
  );
}

/** A task's record page (rail Task · Linked, Communication; header Edit · Assign · Schedule · Complete · Delete). */
export function DemoTaskRecord({ row, onBack, toast }: { row: TaskFixtureRow; onBack: () => void; toast: (text: string) => void }) {
  const detail = OPS_TASK_DETAILS[row.id] ?? OPS_NEW_TASK;
  const sections = useMemo(() => recordSections("manager", "task", { taskListTab: row.bucket }), [row.bucket]);
  const [active, setActive] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const actions: DemoRecordAction[] = sections.headerActions.map((action) => ({
    id: action.id,
    label: action.id === "complete" && row.bucket === "completed" ? "Reopen" : action.label,
    icon: action.icon,
    tone: action.id === "complete" ? "primary" : action.tone,
    onClick: () => {
      if (action.id === "edit") setEditing(true);
      else if (action.id === "delete") setDeleting(true);
      else if (action.id === "complete") {
        toast(`${row.bucket === "completed" ? "Reopen" : "Complete"} (sample)`);
        onBack();
      } else toast(`${action.label} (sample)`);
    },
  }));
  const checklist = detail.checklist.split("\n").filter(Boolean);
  const vendor = detail.assignee.startsWith("vendor") ? assigneeLabel(detail.assignee) : "";
  return (
    <>
      <DemoRecordPage
        title={row.title}
        subtitle={row.when}
        backLabel="Back to tasks"
        onBack={onBack}
        actions={actions}
        sections={sections}
        recordId={row.id}
        activeId={active}
        onActive={setActive}
        ariaLabel="Task sections"
      >
        {active === "communication" ? (
          <RecordCommunication name={vendor} subtitle={row.place} messages={detail.thread} onSent={() => toast("Message sent (sample)")} />
        ) : active === "linked" ? (
          <div className="space-y-3">
            <RecordRowsCard title="Linked" rows={detail.linked.map((l) => ({ id: l.id, title: l.title, sub: l.sub }))} emptyLabel="Nothing linked yet." dataAttr="task-linked-card" />
          </div>
        ) : (
          <div className="space-y-4" data-attr="task-detail-sections">
            <RecordFactCard title="Task" dataAttr="record-overview-card-task">
              <RecordFactRow label="Status" value={detail.status} />
              <RecordFactRow label="Type" value={OPS_TASK_KIND_OPTIONS.find((k) => k.value === detail.kind)?.label ?? "General"} />
              <RecordFactRow label="Property" value={row.place} />
              <RecordFactRow label="Assigned to" value={row.assignee} />
              <RecordFactRow label={row.bucket === "completed" ? "Completed" : row.bucket === "scheduled" ? "When" : "Due"} value={row.when} />
              <RecordFactRow label="Priority" value={PRIORITY_OPTIONS.find((p) => p.value === detail.priority)?.label ?? "Medium"} />
              <RecordFactRow label="Created" value={detail.created} />
            </RecordFactCard>
            {detail.notes ? (
              <RecordFactCard title="Notes" dataAttr="record-overview-card-notes">
                <RecordFactRow label="Notes" value={detail.notes} />
              </RecordFactCard>
            ) : null}
            {checklist.length ? (
              <RecordFactCard title="Checklist" dataAttr="record-overview-card-checklist">
                {checklist.map((step, index) => (
                  <RecordFactRow key={step} label={`Step ${index + 1}`} value={row.bucket === "completed" ? `${step} (done)` : step} />
                ))}
              </RecordFactCard>
            ) : null}
          </div>
        )}
      </DemoRecordPage>
      {editing ? (
        <DemoTaskFormPopup
          mode="edit"
          task={detail}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Task saved (sample)");
          }}
        />
      ) : null}
      {deleting ? (
        <DemoConfirmDialog
          title="Delete task"
          body={`Delete ${row.title}? This cannot be undone.`}
          confirmLabel="Delete"
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            toast("Task deleted (sample)");
            onBack();
          }}
        />
      ) : null}
    </>
  );
}

/* ═════════════════════════════════ BOOKINGS ═════════════════════════════════ */

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseStay(stay: string): { start: Date; end: Date } | null {
  const [a, b] = stay.split(" – ");
  const parse = (label?: string) => {
    if (!label) return null;
    const [month, day] = label.split(" ");
    return month && day && MONTHS[month] !== undefined ? new Date(2025, MONTHS[month]!, Number(day)) : null;
  };
  const start = parse(a);
  const end = parse(b);
  return start && end ? { start, end } : null;
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** A booking stays through the night before it checks out. */
const activeOn = (stay: { start: Date; end: Date }, day: Date) => day.getTime() >= stay.start.getTime() && day.getTime() < stay.end.getTime();
const bedsOf = (place: string) => {
  const house = OPS_HOUSES.find((h) => h.label === place.split(" · ")[0]);
  return Math.max(1, house?.rooms.length ?? 1);
};
const bookingPlace = (row: BookingFixtureRow) => row.place;

/** The Add booking pop-up (`BookingsBlockDatesModal`): Property · When · Review. */
export function DemoBookingPopup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [houseId, setHouseId] = useState("prop-alder");
  const [resident, setResident] = useState("");
  const [newResident, setNewResident] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [room, setRoom] = useState("");
  const [source, setSource] = useState("Direct");
  const [notes, setNotes] = useState("");
  const [linen, setLinen] = useState("");
  const [baggage, setBaggage] = useState("");
  const [early, setEarly] = useState("");
  const [late, setLate] = useState("");
  const [checkIn, setCheckIn] = useState("2025-10-12");
  const [checkOut, setCheckOut] = useState("2025-10-15");
  const house = OPS_HOUSES.find((h) => h.id === houseId);
  const person = OPS_RESIDENTS.find((r) => r.id === resident);
  const whenSummary = checkIn && checkOut ? `${longDate(checkIn)} – ${longDate(checkOut)}` : "Dates";
  const steps = [
    { id: "property", label: "Property", summary: house?.label || "Pick a house" },
    { id: "when", label: "When", summary: whenSummary },
    { id: "review", label: "Review", summary: "Add booking" },
  ];
  return (
    <DemoWorkspacePopup
      title="Add booking"
      steps={steps}
      footer={{ kind: "wizard", lastLabel: "Add booking", onFinish: onSaved }}
      onClose={onClose}
      stepHeading=""
      dataAttr="bookings-block-dates-modal"
    >
      {(step) =>
        step === 0 ? (
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            <Pick id="bookings-block-property" label="Property" value={houseId} onChange={(next) => { setHouseId(next); setRoom(""); }} options={[{ value: "", label: "Select property" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))]} full />
            <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <div className={cn(MODAL_FIELD_LABEL_CLASS, "flex items-center")}>
                <span>Resident</span>
                <button type="button" className="ml-auto text-xs font-semibold text-primary hover:underline" onClick={() => setNewResident((v) => !v)}>
                  {newResident ? "Pick from list instead" : "+ New resident"}
                </button>
              </div>
              {newResident ? (
                <div className="space-y-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3">
                  <Input value={name} placeholder="Full name" aria-label="New resident name" onChange={(e) => setName(e.target.value)} />
                  <Input type="email" value={email} placeholder="Email" aria-label="New resident email" onChange={(e) => setEmail(e.target.value)} />
                  <Input type="tel" value={phone} placeholder="Phone" aria-label="New resident phone" onChange={(e) => setPhone(e.target.value)} />
                </div>
              ) : (
                <Select aria-label="Resident" value={resident} onChange={(e) => setResident(e.target.value)}>
                  <option value="">No one — just close the room</option>
                  {OPS_RESIDENTS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {`${r.name} · ${houseLabel(r.houseId)} · ${r.room}`}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {houseId ? (
              <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
                <div className={MODAL_FIELD_LABEL_CLASS}>Room</div>
                <Select aria-label="Room" value={room} onChange={(e) => setRoom(e.target.value)}>
                  <option value="">{house && house.rooms.length ? "Whole home (every room)" : "Whole home"}</option>
                  {(house?.rooms ?? []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
          </div>
        ) : step === 1 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Pick id="booking-stay-source" label="Source" value={source} onChange={setSource} options={toOptions(OPS_BOOKING_SOURCES)} />
              <Text id="booking-stay-notes" label="Notes" value={notes} onChange={setNotes} />
              <Pick id="booking-stay-linen" label="Linen" value={linen} onChange={setLinen} options={[{ value: "", label: "—" }, { value: "Requested", label: "Requested" }, { value: "Delivered", label: "Delivered" }]} />
              <Pick id="booking-stay-baggage" label="Baggage" value={baggage} onChange={setBaggage} options={[{ value: "", label: "—" }, { value: "Yes", label: "Yes" }, { value: "No", label: "No" }]} />
              <Text id="booking-stay-early" label="Early check-in" type="time" value={early} onChange={setEarly} />
              <Text id="booking-stay-late" label="Late check-out" type="time" value={late} onChange={setLate} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Text id="bookings-block-check-in" label="Move in" type="date" value={checkIn} onChange={setCheckIn} />
              <Text id="bookings-block-check-out" label="Move out" type="date" value={checkOut} onChange={setCheckOut} />
            </div>
          </div>
        ) : (
          <ReviewList
            rows={[
              ["Property", house?.label ?? ""],
              ["Room", room || (house ? "Whole home" : "")],
              ["Resident", newResident ? name || "New resident" : person ? person.name : "No one — just close the room"],
              ["When", whenSummary],
            ]}
          />
        )
      }
    </DemoWorkspacePopup>
  );
}

const dayTitle = (day: Date) => day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const dayStatusLabel = (row: BookingFixtureRow) => [row.source ?? "Direct", row.status].join(" · ");

/** The booking day (`BookingsDayPage`): a dialog titled like "Thursday, September 25" with prev / next day chevrons. */
export function DemoBookingDayDialog({
  day: initialDay,
  rows,
  onClose,
  onOpen,
  toast,
}: {
  day: Date;
  rows: BookingFixtureRow[];
  onClose: () => void;
  onOpen: (row: BookingFixtureRow) => void;
  toast: (text: string) => void;
}) {
  const [day, setDay] = useState(initialDay);
  const move = (by: number) => setDay((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + by));
  const stays = rows
    .map((row) => ({ row, stay: parseStay(row.stay) }))
    .filter((entry): entry is { row: BookingFixtureRow; stay: { start: Date; end: Date } } => Boolean(entry.stay));
  const today = stays.filter(({ stay }) => activeOn(stay, day));
  const checkIns = stays.filter(({ stay }) => sameDay(stay.start, day)).length;
  const properties = OPS_HOUSES.map((h) => h.label);
  const occupied = today.filter(({ row }) => row.status !== "Hold").length;
  const totalBeds = properties.reduce((sum, p) => sum + bedsOf(p), 0);
  const groups = properties
    .map((property) => ({ property, entries: today.filter(({ row }) => row.place.split(" · ")[0] === property) }))
    .filter((group) => group.entries.length > 0);
  return (
    <DemoSmallDialog
      wide
      title={dayTitle(day)}
      onClose={onClose}
      headerAction={
        <div className="flex shrink-0 items-center gap-1" data-attr="bookings-day-page-header">
          {[
            { label: "Previous day", icon: ChevronLeft, by: -1 },
            { label: "Next day", icon: ChevronRight, by: 1 },
          ].map(({ label, icon: Icon, by }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground"
              onClick={() => move(by)}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-3 min-w-0 truncate text-[13px] text-muted" data-attr="bookings-day-summary">
        {`${occupied} of ${totalBeds} beds occupied · ${checkIns} check-in${checkIns === 1 ? "" : "s"}`}
      </p>
      <PortalRecordListSurface isEmpty={groups.length === 0} emptyCard={{ title: "No bookings this day", section: "bookings" }} dataAttr="bookings-day-list">
        {groups.map((group) => (
          <div key={group.property}>
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted sm:px-4">
              <span className="truncate">{group.property}</span>
              <span className="shrink-0 tabular-nums">
                {group.entries.filter(({ row }) => row.status !== "Hold").length} of {bedsOf(group.property)} beds
              </span>
            </div>
            {group.entries.map(({ row }) => {
              const isBlock = !OPS_BOOKING_DETAILS[row.id]?.isChannel;
              return (
                <BookingsRowOverflow
                  key={row.id}
                  label={row.guest}
                  onEditDates={isBlock ? () => toast("Edit booking (sample)") : undefined}
                  editDatesLabel="Edit booking"
                  onMessage={() => onOpen(row)}
                  onCopyLink={() => toast("Link copied (sample)")}
                  onCancel={isBlock ? () => toast("Booking removed (sample)") : undefined}
                  cancelLabel="Remove booking"
                >
                  <PortalApplicantRecordRow
                    name={row.guest}
                    address={bookingPlace(row)}
                    facts={
                      <>
                        <PortalRowFact icon={CalendarDays} srLabel="Stay">{row.stay}</PortalRowFact>
                        <PortalRowFact icon={Tag} srLabel="Source">{dayStatusLabel(row)}</PortalRowFact>
                      </>
                    }
                    onOpen={() => onOpen(row)}
                    omitActionView
                    dataAttr={`bookings-day-row-${row.id}`}
                    onSelectedChange={() => {}}
                  />
                </BookingsRowOverflow>
              );
            })}
          </div>
        ))}
      </PortalRecordListSurface>
    </DemoSmallDialog>
  );
}

/** A booking's record page (rail Booking · Guest, Payments under Linked, Communication; header Message · Edit · cancel). */
export function DemoBookingRecord({ row, onBack, toast, initialSection = "overview" }: { row: BookingFixtureRow; onBack: () => void; toast: (text: string) => void; initialSection?: string }) {
  const detail = OPS_BOOKING_DETAILS[row.id]!;
  const sections = useMemo(() => recordSections("manager", "booking", { basePath: "/portal" }), []);
  const [active, setActive] = useState(initialSection);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const channel = detail.isChannel;
  const actions: DemoRecordAction[] = [
    ...sections.headerActions
      .filter((action) => action.id !== "edit" || !channel)
      .map((action) => ({
        id: action.id,
        label: action.label,
        icon: action.icon,
        tone: action.id === "message" ? ("primary" as const) : action.tone,
        onClick: () => (action.id === "edit" ? setEditing(true) : setActive("communication")),
      })),
    {
      id: "cancel",
      label: channel ? "Remove stay" : "Cancel booking",
      icon: Trash2,
      tone: "danger",
      onClick: () => setCancelling(true),
    },
  ];
  const place = row.place;
  return (
    <>
      <DemoRecordPage
        title={row.guest}
        subtitle={place}
        avatarName={row.guest}
        backLabel="Back to bookings"
        onBack={onBack}
        actions={actions}
        sections={sections}
        recordId={row.id}
        activeId={active}
        onActive={setActive}
        ariaLabel="Booking sections"
      >
        {active === "communication" ? (
          <RecordCommunication name={row.status === "Hold" ? "" : row.guest} subtitle={place} messages={detail.thread} onSent={() => toast("Message sent (sample)")} />
        ) : active === "guest" ? (
          <RecordFactCard title="Guest" dataAttr="booking-guest-card">
            <RecordFactRow label="Name" value={row.guest} />
            <RecordFactRow label="Email" value={detail.email || "—"} />
            <RecordFactRow label="Phone" value={detail.phone || "—"} />
            <RecordFactRow label="Past stays" value={detail.pastStays === 0 ? "None yet" : `${detail.pastStays} · last ${detail.lastStay}`} />
          </RecordFactCard>
        ) : active === "payments" ? (
          <RecordRowsCard
            title="Payments"
            rows={[
              { id: "stay", title: "Stay total", sub: detail.rateCalc, figure: detail.total },
              ...detail.charges.map((c): RecordRowItem => ({ id: c.id, title: c.title, sub: c.sub, figure: c.figure })),
            ]}
            dataAttr="booking-payments-card"
          />
        ) : (
          <RecordFactCard title="Booking" dataAttr="booking-overview-facts">
            <RecordFactRow label="Dates" value={`${row.stay} · ${detail.nights} ${detail.nights === 1 ? "night" : "nights"}`} />
            <RecordFactRow label="Where" value={place} />
            {detail.channel ? <RecordFactRow label="Channel" value={detail.channel} /> : <RecordFactRow label="Source" value={row.status === "Hold" ? "Application" : "Direct"} />}
            {detail.earlyCheckIn || detail.lateCheckOut ? (
              <RecordFactRow label="Check-in / out" value={[detail.earlyCheckIn && `Check-in ${detail.earlyCheckIn}`, detail.lateCheckOut && `Check-out ${detail.lateCheckOut}`].filter(Boolean).join(" · ")} />
            ) : null}
            <RecordFactRow label="Status" value={row.status} />
            <RecordFactRow label="Rate" value={row.rate} />
            {detail.notes ? <RecordFactRow label="Notes" value={detail.notes} /> : null}
            {detail.linen ? <RecordFactRow label="Linen" value={detail.linen} /> : null}
            {detail.baggage ? <RecordFactRow label="Baggage" value={detail.baggage} /> : null}
          </RecordFactCard>
        )}
      </DemoRecordPage>
      {editing ? <DemoBookingPopup onClose={() => setEditing(false)} onSaved={() => { setEditing(false); toast("Booking saved (sample)"); }} /> : null}
      {cancelling ? (
        <DemoConfirmDialog
          title={channel ? "Remove stay" : "Cancel booking"}
          body={`${channel ? "Remove" : "Cancel"} ${row.guest}'s stay at ${place}? This cannot be undone.`}
          confirmLabel={channel ? "Remove" : "Cancel booking"}
          onClose={() => setCancelling(false)}
          onConfirm={() => {
            setCancelling(false);
            toast(`${channel ? "Stay removed" : "Booking cancelled"} (sample)`);
            onBack();
          }}
        />
      ) : null}
    </>
  );
}

/* ═════════════════════════════════ PROMOTION ═════════════════════════════════ */

type PromoKind = "flyer" | "text" | "upload";
const PROMO_KIND_OPTIONS: { value: PromoKind; label: string }[] = [
  { value: "flyer", label: "Flyer" },
  { value: "text", label: "Post or blurb" },
  { value: "upload", label: "Upload your own" },
];
const TEXT_FORMAT_BY_LABEL: Record<string, PromotionTextFormat> = { "Listing blurb": "listing_blurb", "Instagram caption": "instagram_caption" };

/** A flyer draft for a promotion fixture (real `PromotionDraft`, no photos): drives the real flyer preview. */
function flyerDraft(houseId: string, detail?: { headline: string; price?: string; bullets?: string[]; cta?: string; contact?: string; body: string }): PromotionDraft {
  const house = OPS_HOUSES.find((h) => h.id === houseId) ?? OPS_HOUSES[3]!;
  const property = PROPERTY_ROWS.find((p) => p.id === houseId);
  return {
    ...EMPTY_DRAFT,
    propertyKey: house.id,
    propertyLabel: house.label,
    address: property ? `${property.street}, Seattle, WA` : "",
    title: detail?.headline ?? `${house.label} flyer`,
    headline: detail?.headline ?? "",
    sellingPoints: (detail?.bullets ?? []).join("\n"),
    customDetails: detail?.body ?? "",
    price: detail?.price ?? property?.rentLabel ?? "",
    cta: detail?.cta ?? "Book a tour",
    contact: detail?.contact ?? "",
  };
}

/** New promotion: Kind · Content · Preview, with the header "Upload your own" card. */
export function DemoPromotionNewPopup({ onClose, onSaved, editing }: { onClose: () => void; onSaved: (kind: PromoKind) => void; editing?: PromotionFixtureRow }) {
  const editDetail = editing ? OPS_PROMOTION_DETAILS[editing.id] : undefined;
  const editHouse = editing ? OPS_HOUSES.find((h) => h.label === editing.place)?.id ?? "prop-willow" : "prop-willow";
  const [kind, setKind] = useState<PromoKind>(editDetail?.kindId ?? "flyer");
  const [propertyId, setPropertyId] = useState(editHouse);
  const [draft, setDraft] = useState<PromotionDraft>(() => flyerDraft(editHouse, editDetail ?? OPS_PROMOTION_DETAILS["promo-willow-flyer"]));
  const [format, setFormat] = useState<PromotionTextFormat>(editing ? TEXT_FORMAT_BY_LABEL[editing.kind] ?? "listing_blurb" : "listing_blurb");
  const [fileName, setFileName] = useState<string | null>(editDetail?.fileName ?? null);
  const kindLabel = PROMO_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? "Promotion";
  const set = (patch: Partial<PromotionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const lastLabel = editing ? "Save changes" : kind === "flyer" ? "Generate flyer" : kind === "upload" ? "Save promotion" : "Generate promotion text";
  const steps = [
    { id: "kind", label: "Kind", summary: kindLabel },
    { id: "content", label: "Content", summary: kind === "upload" ? fileName || "Choose a file" : draft.title || draft.headline || "Listing facts" },
    { id: "preview", label: "Preview", summary: kindLabel },
  ];
  const textCopy = { format, hook: draft.headline || draft.title, body: [draft.address, draft.price, draft.sellingPoints, draft.customDetails].filter(Boolean).join("\n\n"), hashtags: "", ctaLine: [draft.cta, draft.contact].filter(Boolean).join(" · ") };
  const preview =
    kind === "flyer" ? (
      <PromotionFlyerPreview promotion={draftToPreviewRow(draft)} embedded />
    ) : kind === "upload" ? (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{fileName ?? "Choose a file"}</div>
    ) : (
      <PromotionTextPreview copy={textCopy} variant="boxed" />
    );
  const changeProperty = (next: string) => {
    setPropertyId(next);
    setDraft(flyerDraft(next));
  };
  return (
    <DemoWorkspacePopup
      title={editing ? "Edit promotion" : "New promotion"}
      steps={steps}
      sidePanel={preview}
      footer={{ kind: "wizard", lastLabel, onFinish: () => onSaved(kind) }}
      onClose={onClose}
      stepHeading=""
      dataAttr="promotion-new-popup"
    >
      {(step) =>
        step === 0 ? (
          <StepColumn>
            {editing ? null : (
              <WorkspaceFileCard
                accept={PROMOTION_UPLOAD_ACCEPT}
                chips={["images", ".pdf", "up to 12 MB"]}
                label="Upload your own"
                dataAttr="promotion-new-header-upload"
                fileName={fileName}
                onPick={(file) => {
                  setKind("upload");
                  setFileName(file.name);
                }}
              />
            )}
            <StepHeading title="Kind" />
            <WizardSelect label="Kind" value={kind} onChange={(next) => setKind(next as PromoKind)} options={PROMO_KIND_OPTIONS} dataAttr="promotion-new-kind" />
            <WizardSelect label="Property" value={propertyId} onChange={changeProperty} options={[{ value: "", label: "Custom" }, ...OPS_PROMOTION_PROPERTIES]} dataAttr="promotion-new-property" />
          </StepColumn>
        ) : step === 1 ? (
          <StepColumn wide>
            <StepHeading title="Content" />
            {kind === "flyer" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Text id="promotion-flyer-label" label="Property label (shown on flyer)" value={draft.propertyLabel} onChange={(propertyLabel) => set({ propertyLabel })} />
                <Text id="promotion-flyer-address" label="Address (shown on flyer)" value={draft.address} onChange={(address) => set({ address })} />
                <Text id="promotion-flyer-name" label="Flyer name" value={draft.title} onChange={(title) => set({ title })} full />
                <Text id="promotion-flyer-headline" label="Headline idea (optional)" value={draft.headline} onChange={(headline) => set({ headline })} full />
                <Field label="Key selling points / amenities (one per line)" htmlFor="promotion-flyer-points" full>
                  <Textarea id="promotion-flyer-points" rows={4} value={draft.sellingPoints} onChange={(e) => set({ sellingPoints: e.target.value })} />
                </Field>
                <Text id="promotion-flyer-price" label="Price" value={draft.price} onChange={(price) => set({ price })} />
                <Text id="promotion-flyer-promo" label="Promotional offer" value={draft.promo} onChange={(promo) => set({ promo })} />
                <Text id="promotion-flyer-cta" label="Call to action" value={draft.cta} onChange={(cta) => set({ cta })} />
                <Text id="promotion-flyer-contact" label="Contact" value={draft.contact} onChange={(contact) => set({ contact })} />
                <Pick id="promotion-flyer-theme" label="Theme" value={draft.theme} onChange={(theme) => set({ theme: theme as PromotionDraft["theme"] })} options={PROMOTION_THEME_OPTIONS.map((t) => ({ value: t.id, label: t.label }))} />
                <Pick id="promotion-flyer-tone" label="Tone" value={draft.tone} onChange={(tone) => set({ tone })} options={toOptions(PROMOTION_TONE_OPTIONS)} />
                <Pick id="promotion-flyer-size" label="Flyer size" value={draft.flyerSize} onChange={(flyerSize) => set({ flyerSize: flyerSize as PromotionDraft["flyerSize"] })} options={PROMOTION_SIZE_OPTIONS.map((s) => ({ value: s.id, label: s.label }))} full />
                <div className="sm:col-span-2">
                  <label className={MODAL_FIELD_LABEL_CLASS}>Flyer template</label>
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Flyer template">
                    {PROMOTION_TEMPLATE_OPTIONS.map((t) => {
                      const active = draft.template === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          title={t.description}
                          onClick={() => set({ template: t.id as PromotionTemplate })}
                          className={`rounded-xl border p-2 text-left outline-none transition-[border-color,box-shadow] ${active ? "border-primary/60 ring-2 ring-primary/20" : "border-border hover:border-primary/30"}`}
                          data-attr="promotion-template-option"
                        >
                          <TemplateThumb id={t.id as PromotionTemplate} />
                          <div className={`mt-1.5 truncate text-[11px] font-semibold ${active ? "text-primary" : "text-foreground"}`}>{t.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : kind === "upload" ? (
              <div className="space-y-4">
                {fileName ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{fileName}</p>
                    <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setFileName("alder-house-kitchen.jpg")}>
                      Replace
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-accent/20 px-4 py-10 text-center"
                    onClick={() => setFileName("alder-house-kitchen.jpg")}
                  >
                    <span className="text-sm font-semibold text-foreground">Drop or click to upload</span>
                    <span className="text-xs text-muted">JPG, PNG, or PDF · up to 12 MB</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <WizardField label="Headline">
                  <Input value={draft.headline} onChange={(e) => set({ headline: e.target.value })} />
                </WizardField>
                <WizardField label="Content">
                  <Textarea rows={5} value={draft.customDetails} onChange={(e) => set({ customDetails: e.target.value })} />
                </WizardField>
                <WizardSelect label="Format" value={format} onChange={(next) => setFormat(next as PromotionTextFormat)} options={PROMOTION_TEXT_FORMAT_OPTIONS.map((o) => ({ value: o.id, label: o.label }))} />
                <WizardSelect label="Tone" value={draft.tone} onChange={(tone) => set({ tone })} options={toOptions(PROMOTION_TONE_OPTIONS)} />
              </div>
            )}
          </StepColumn>
        ) : (
          <StepColumn>
            <StepHeading title="Preview" />
            {preview}
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

/** Row click on a promotion: the real "View · <title>" modal, with a Download (flyer / upload) or Copy text + Download footer. */
export function DemoPromotionViewDialog({ row, onClose, toast }: { row: PromotionFixtureRow; onClose: () => void; toast: (text: string) => void }) {
  const detail = OPS_PROMOTION_DETAILS[row.id]!;
  const footer =
    detail.kindId === "text" ? (
      <>
        <Button type="button" variant="outline" className="rounded-full" data-attr="promotion-text-copy" onClick={() => toast("Copied to clipboard (sample)")}>
          Copy text
        </Button>
        <Button type="button" variant="primary" className="ml-auto rounded-full" data-demo-target="sheet-primary" data-attr="promotion-text-download" onClick={() => toast("Download (sample)")}>
          Download
        </Button>
      </>
    ) : (
      <Button
        type="button"
        variant="primary"
        className="ml-auto rounded-full"
        data-demo-target="sheet-primary"
        data-attr={detail.kindId === "flyer" ? "promotion-flyer-download" : "promotion-upload-download"}
        onClick={() => toast("Download (sample)")}
      >
        {detail.kindId === "flyer" ? "Download flyer" : "Download"}
      </Button>
    );
  return (
    <DemoSmallDialog wide title={`View · ${row.title}`} onClose={onClose} footer={<div className="flex w-full items-center gap-2">{footer}</div>}>
      {detail.kindId === "flyer" ? (
        <div className="min-w-0 rounded-xl border border-border bg-card">
          <PromotionFlyerPreview promotion={draftToPreviewRow(flyerDraft(OPS_HOUSES.find((h) => h.label === row.place)?.id ?? "prop-willow", detail))} embedded />
        </div>
      ) : detail.kindId === "text" ? (
        <PromotionTextPreview
          copy={{ format: TEXT_FORMAT_BY_LABEL[row.kind] ?? "listing_blurb", hook: detail.headline, body: detail.body, hashtags: "", ctaLine: "" }}
          variant="plain"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card p-2">
          <div className="grid h-64 place-items-center rounded-lg bg-accent/40 text-muted">
            <span className="flex flex-col items-center gap-2 text-sm">
              <FileText className="size-8" aria-hidden />
              {detail.fileName}
            </span>
          </div>
        </div>
      )}
    </DemoSmallDialog>
  );
}

/* ═════════════════════════════════ OUTGOING PAYMENTS ═════════════════════════════════ */

const CATEGORY_OPTIONS = OUTGOING_PAYMENT_CATEGORY_CODES.map((code) => ({
  value: code,
  label: SYSTEM_CHART_ACCOUNTS.find((a) => a.code === code)?.name ?? code,
}));
const NEW_PAYEE = "new";
const NEW_BILL = "new";

type PayKind = "vendor" | "teammate" | "other";

/** Add payment: Pay to · Payment · Review (a vendor with a login pays by invoice, in one step). */
export function DemoOutgoingAddPopup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [payKind, setPayKind] = useState<PayKind>("other");
  const [vendorKey, setVendorKey] = useState("v-rainier");
  const [vendorFor, setVendorFor] = useState("");
  const [billService, setBillService] = useState("");
  const [billTitle, setBillTitle] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [teammate, setTeammate] = useState("team-sam");
  const [reason, setReason] = useState<string>(TEAMMATE_PAYMENT_REASONS[0]!);
  const [payee, setPayee] = useState("payee-chase");
  const [np, setNp] = useState({ name: "", type: "", account: "", method: "", phone: "", email: "", address: "", notes: "" });
  const [category, setCategory] = useState("mortgage");
  const [amount, setAmount] = useState("1,850.00");
  const [paidOn, setPaidOn] = useState("2025-09-25");
  const [property, setProperty] = useState("");
  const [memo, setMemo] = useState("October payment");
  const vendor = OPS_PAY_VENDORS.find((v) => v.value === vendorKey);
  const invoicePath = payKind === "vendor" && Boolean(vendor?.hasLogin);
  const newBill = invoicePath && vendorFor === NEW_BILL;
  const creatingPayee = payKind === "other" && payee === NEW_PAYEE;
  const setNew = (patch: Partial<typeof np>) => setNp((current) => ({ ...current, ...patch }));
  const payeeName = payKind === "vendor" ? vendor?.label ?? "" : payKind === "teammate" ? OPS_TEAMMATES.find((t) => t.value === teammate)?.label.split(" · ")[0] ?? "" : creatingPayee ? np.name : OPS_PAYEES.find((p) => p.value === payee)?.label.split(" · ")[0] ?? "";
  const payToSummary = payeeName || "Choose who you are paying";
  const categoryLabel = CATEGORY_OPTIONS.find((c) => c.value === category)?.label ?? category;
  const steps = invoicePath
    ? [{ id: "payto", label: "Pay to", summary: payToSummary }]
    : [
        { id: "payto", label: "Pay to", summary: payToSummary },
        { id: "payment", label: "Payment", summary: amount ? `${categoryLabel} · $${amount}` : "Amount" },
        { id: "review", label: "Review", summary: "Ready" },
      ];
  return (
    <DemoWorkspacePopup
      title="Add payment"
      steps={steps}
      footer={{ kind: "wizard", lastLabel: invoicePath ? (newBill ? "Create bill" : "Continue") : "Add payment", onFinish: onSaved }}
      onClose={onClose}
      dataAttr="outgoing-payment-popup"
    >
      {(step) =>
        step === 0 ? (
          <StepColumn>
            <SegmentedThree<PayKind>
              value={payKind}
              onChange={setPayKind}
              first={{ id: "vendor", label: "A vendor" }}
              second={{ id: "teammate", label: "A teammate" }}
              third={{ id: "other", label: "Someone else" }}
              className="mb-4"
            />
            {payKind === "vendor" ? (
              <>
                <WizardSelect label="Vendor" required value={vendorKey} onChange={(next) => { setVendorKey(next); setVendorFor(""); }} placeholder="Choose vendor" options={OPS_PAY_VENDORS.map((v) => ({ value: v.value, label: v.label }))} dataAttr="outgoing-payment-vendor" />
                {invoicePath ? (
                  <WizardSelect
                    label="For"
                    required
                    value={vendorFor}
                    onChange={setVendorFor}
                    placeholder="Choose what you are paying"
                    options={[
                      ...Object.entries(OPS_OUTGOING_DETAILS)
                        .filter(([id]) => id === "out-evergreen")
                        .map(([id, d]) => ({ value: id, label: ["Approved invoice", d.invoice, d.service, "$240.00"].join(" · ") })),
                      { value: NEW_BILL, label: "New bill" },
                    ]}
                    dataAttr="outgoing-payment-for"
                  />
                ) : null}
                {newBill ? (
                  <>
                    <WizardSelect label="Service" required value={billService} onChange={setBillService} placeholder="Choose service" options={[{ value: "s1", label: "Slow bathroom drain" }, { value: "s2", label: "Outlet repair" }]} dataAttr="outgoing-payment-service" />
                    <WizardField label="Description" required>
                      <Input value={billTitle} onChange={(e) => setBillTitle(e.target.value)} />
                    </WizardField>
                    <WizardField label="Amount" required>
                      <Input inputMode="decimal" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} placeholder="185" />
                    </WizardField>
                  </>
                ) : null}
              </>
            ) : null}
            {payKind === "teammate" ? (
              <>
                <WizardSelect label="Teammate" required value={teammate} onChange={setTeammate} placeholder="Choose teammate" options={OPS_TEAMMATES} dataAttr="outgoing-payment-teammate" />
                <WizardSelect label="For" value={reason} onChange={setReason} options={TEAMMATE_PAYMENT_REASONS.map((r) => ({ value: r, label: r }))} dataAttr="outgoing-payment-teammate-reason" />
              </>
            ) : null}
            {payKind === "other" ? (
              <>
                <WizardSelect label="Payee" required value={payee} onChange={setPayee} placeholder="Choose payee" options={[...OPS_PAYEES, { value: NEW_PAYEE, label: "New payee" }]} dataAttr="outgoing-payment-payee" />
                {creatingPayee ? (
                  <>
                    <WizardField label="Name" required>
                      <Input value={np.name} onChange={(e) => setNew({ name: e.target.value })} placeholder="Chase Home Lending" />
                    </WizardField>
                    <WizardRow>
                      <WizardSelect label="Type" required value={np.type} onChange={(type) => setNew({ type })} placeholder="Choose type" options={PICKABLE_PAYEE_TYPES.map((t) => ({ value: t, label: PAYEE_TYPE_LABEL[t] }))} dataAttr="outgoing-payment-payee-type" />
                      <WizardField label="Account / loan number">
                        <Input value={np.account} onChange={(e) => setNew({ account: e.target.value })} autoComplete="off" />
                      </WizardField>
                    </WizardRow>
                    <WizardRow>
                      <WizardSelect label="How you pay them" value={np.method} onChange={(method) => setNew({ method })} placeholder="Choose how" options={PAY_METHODS.map((m) => ({ value: m, label: PAY_METHOD_LABEL[m] }))} dataAttr="outgoing-payment-payee-method" />
                      <WizardField label="Phone">
                        <Input type="tel" value={np.phone} onChange={(e) => setNew({ phone: e.target.value })} />
                      </WizardField>
                    </WizardRow>
                    <WizardField label="Email">
                      <Input type="email" value={np.email} onChange={(e) => setNew({ email: e.target.value })} />
                    </WizardField>
                    <WizardField label="Address">
                      <Input value={np.address} onChange={(e) => setNew({ address: e.target.value })} />
                    </WizardField>
                    <WizardField label="Notes">
                      <Textarea value={np.notes} onChange={(e) => setNew({ notes: e.target.value })} placeholder="e.g. pay by the 1st, autopay off" />
                    </WizardField>
                  </>
                ) : null}
              </>
            ) : null}
          </StepColumn>
        ) : step === 1 ? (
          <StepColumn>
            <WizardRow>
              <WizardSelect label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} dataAttr="outgoing-payment-category" />
              <WizardField label="Amount" required>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="185" />
              </WizardField>
            </WizardRow>
            <WizardRow>
              <WizardField label="Paid on" required>
                <Input type="date" className="portal-modal-date-input" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </WizardField>
              <WizardSelect label="Property" value={property} onChange={setProperty} options={[{ value: "", label: "Portfolio" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))]} dataAttr="outgoing-payment-property" />
            </WizardRow>
            <WizardField label="Memo">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="October payment" />
            </WizardField>
          </StepColumn>
        ) : (
          <StepColumn>
            <WizardSection title="Payment" dataAttr="outgoing-payment-review">
              <WizardLine label="Pay to" control={<span className="font-bold">{payeeName || "—"}</span>} />
              <WizardLine label="Category" control={<span>{categoryLabel}</span>} />
              <WizardLine label="Amount" control={<span className="font-bold">{amount ? `$${amount}` : "—"}</span>} />
              <WizardLine label="Paid on" control={<span>{paidOn}</span>} />
              <WizardLine label="Property" control={<span>{OPS_HOUSES.find((h) => h.id === property)?.label ?? "Portfolio"}</span>} />
              {payKind === "teammate" ? <WizardLine label="For" control={<span>{reason}</span>} /> : null}
              {memo.trim() ? <WizardLine label="Memo" control={<span className="text-right">{memo.trim()}</span>} /> : null}
            </WizardSection>
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

export type OutgoingDialogKind = "view" | "pay" | "schedule" | "offline" | "delete";

/** The small dialogs a bill opens: the Invoice, Pay vendor, Schedule payment, Mark paid outside PropLane, Delete bill. */
export function DemoOutgoingDialog({ kind, row, onClose, onDone }: { kind: OutgoingDialogKind; row: OutgoingFixtureRow; onClose: () => void; onDone: (text: string) => void }) {
  const detail = OPS_OUTGOING_DETAILS[row.id]!;
  const [date, setDate] = useState(kind === "offline" ? "2025-09-25" : "2025-10-01");
  const [method, setMethod] = useState("Check");
  const paid = row.bucket === "paid";
  if (kind === "view") {
    return (
      <DemoSmallDialog
        title="Invoice"
        onClose={onClose}
        footer={!paid ? <PrimaryButton onClick={() => onDone("Pay now (sample)")}>Pay now</PrimaryButton> : undefined}
      >
        <ConfirmRows
          rows={[
            { label: "Vendor", value: row.vendor },
            { label: "For", value: detail.service },
            { label: "Property", value: row.property },
            { label: "Status", value: paid ? "Paid" : row.bucket === "scheduled" ? "Scheduled" : "To pay" },
            { label: paid ? "Paid on" : row.bucket === "scheduled" ? "Pays on" : "Due", value: row.when.replace(/^(Due|Pays|Paid) /, "") },
            { label: paid ? "Paid with" : "Pays with", value: row.method },
            ...detail.lines.map((line) => ({ label: `${line.description} × ${line.quantity}`, value: line.amount })),
            { label: "Total", value: <strong>{row.amount}</strong> },
          ]}
        />
      </DemoSmallDialog>
    );
  }
  if (kind === "pay") {
    return (
      <DemoSmallDialog title="Pay vendor" onClose={onClose} footer={<PrimaryButton onClick={() => onDone("Payment sent (sample)")}>{`Pay ${row.amount}`}</PrimaryButton>}>
        <div className="space-y-4 text-sm">
          <div className="flex justify-between"><span>{row.vendor}</span><strong>{row.amount}</strong></div>
          <div className="flex justify-between"><span className="text-muted">Pay from</span><span>PropLane balance</span></div>
        </div>
      </DemoSmallDialog>
    );
  }
  if (kind === "delete") {
    return <DemoConfirmDialog title="Delete bill" body={`Delete the ${row.amount} bill from ${row.vendor}?`} confirmLabel="Delete bill" onClose={onClose} onConfirm={() => onDone("Bill deleted (sample)")} />;
  }
  return (
    <DemoSmallDialog
      title={kind === "schedule" ? "Schedule payment" : "Mark paid outside PropLane"}
      onClose={onClose}
      footer={<PrimaryButton onClick={() => onDone(kind === "schedule" ? "Payment scheduled (sample)" : "Marked paid (sample)")}>{kind === "schedule" ? "Schedule" : "Mark paid"}</PrimaryButton>}
    >
      <div className="space-y-4">
        <Text id="outgoing-action-date" label={kind === "schedule" ? "Pay on" : "Paid on"} type="date" value={date} onChange={setDate} />
        {kind === "offline" ? <Pick id="outgoing-action-method" label="Method" value={method} onChange={setMethod} options={toOptions(["Cash", "Check", "Bank transfer", "Other"])} /> : null}
        <ConfirmRows rows={[{ label: "To", value: row.vendor }, { label: "Amount", value: row.amount }, ...(kind === "schedule" ? [{ label: "Pay from", value: "PropLane balance" }] : [])]} />
      </div>
    </DemoSmallDialog>
  );
}

/** A bill's record page (rail Payment, Communication; header View invoice · Schedule · Mark paid · Delete bill · Pay now). */
export function DemoOutgoingRecord({ row, onBack, toast }: { row: OutgoingFixtureRow; onBack: () => void; toast: (text: string) => void }) {
  const detail = OPS_OUTGOING_DETAILS[row.id]!;
  const sections = useMemo(() => recordSections("manager", "vendor-bill", { basePath: "/portal" }), []);
  const [active, setActive] = useState("overview");
  const [dialog, setDialog] = useState<OutgoingDialogKind | null>(null);
  const state = row.bucket;
  const show: Record<string, boolean> = {
    "view-invoice": true,
    schedule: state !== "paid",
    "mark-paid": state !== "paid",
    delete: detail.managerEntered && state !== "paid",
    "pay-now": state !== "paid",
  };
  const dialogFor: Record<string, OutgoingDialogKind> = { "view-invoice": "view", schedule: "schedule", "mark-paid": "offline", delete: "delete", "pay-now": "pay" };
  const actions: DemoRecordAction[] = ["view-invoice", "schedule", "mark-paid", "delete", "pay-now"]
    .map((id) => sections.headerActions.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a) && show[a!.id] === true)
    .map((a) => ({
      id: a.id,
      label: a.id === "schedule" && state === "scheduled" ? "Change date" : a.label,
      icon: a.icon,
      tone: a.tone,
      demoTarget: undefined,
      onClick: () => setDialog(dialogFor[a.id]!),
    }));
  const when = row.when.replace(/^(Due|Pays|Paid) /, "");
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: "Vendor", value: row.vendor },
    { label: "Service", value: detail.service },
    { label: "Property", value: row.property },
    { label: "Status", value: state === "paid" ? "Paid" : state === "scheduled" ? "Scheduled" : "To pay" },
    { label: "Amount", value: row.amount },
    { label: state === "paid" ? "Paid on" : state === "scheduled" ? "Pays on" : "Due", value: when },
    { label: state === "paid" ? "Paid with" : "Pays with", value: row.method },
    { label: "Invoice", value: detail.invoice },
    { label: "Billed by", value: detail.managerEntered ? "You (entered by hand)" : row.vendor },
  ];
  return (
    <>
      <DemoRecordPage
        title={row.vendor}
        subtitle={`${detail.service} · ${row.amount}`}
        avatarName={row.vendor}
        backLabel="Back to outgoing payments"
        onBack={onBack}
        actions={actions}
        sections={sections}
        recordId={row.id}
        activeId={active}
        onActive={setActive}
        ariaLabel="Payment sections"
      >
        {active === "communication" ? (
          <RecordCommunication name={detail.thread.length ? row.vendor : ""} subtitle={detail.service} messages={detail.thread} onSent={() => toast("Message sent (sample)")} />
        ) : (
          <div className="space-y-3" data-attr="outgoing-payment-record" data-out-state={state}>
            <RecordFactCard title="Payment" dataAttr="outgoing-payment-card">
              {rows.map((r) => (
                <RecordFactRow key={r.label} label={r.label} value={r.value} />
              ))}
            </RecordFactCard>
            <RecordFactCard title="Invoice" dataAttr="outgoing-payment-invoice">
              {detail.lines.map((line, index) => (
                <RecordFactRow key={index} label={`${line.description} × ${line.quantity}`} value={line.amount} />
              ))}
              <RecordFactRow label="Total" value={<strong>{row.amount}</strong>} />
            </RecordFactCard>
            <RecordRowsCard title="History" rows={detail.history.map((h) => ({ id: h.id, title: h.title, sub: h.sub, figure: h.figure }))} dataAttr="outgoing-payment-history" />
          </div>
        )}
      </DemoRecordPage>
      {dialog ? (
        <DemoOutgoingDialog
          kind={dialog}
          row={row}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            toast(text);
            if (dialog === "delete") onBack();
          }}
        />
      ) : null}
    </>
  );
}

/* ═════════════════════════════════ FINANCES ═════════════════════════════════ */

const EXPENSE_CATEGORIES = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "expense");
const INCOME_CATEGORIES = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "income");

/** The small "Financial entry" dialog: a Type select (Expense or Income) and Continue. */
export function DemoFinancialEntryDialog({ onClose, onContinue }: { onClose: () => void; onContinue: (kind: "expense" | "income") => void }) {
  const [kind, setKind] = useState<"expense" | "income">("expense");
  return (
    <DemoSmallDialog title="Financial entry" onClose={onClose} footer={<PrimaryButton onClick={() => onContinue(kind)}>Continue</PrimaryButton>}>
      <FieldSingleSelect label="Type" value={kind} onChange={(value) => setKind(value as "expense" | "income")} options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]} />
    </DemoSmallDialog>
  );
}

const finStepOptions = [{ value: "", label: "Portfolio" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))];

/** Add expense: What · Where · Review (the real pop-up on Finances). */
export function DemoExpensePopup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]?.code ?? "maintenance");
  const [amount, setAmount] = useState("185.00");
  const [date, setDate] = useState("2025-09-25");
  const [memo, setMemo] = useState("");
  const [deductible, setDeductible] = useState(true);
  const [property, setProperty] = useState("");
  const [vendor, setVendor] = useState("");
  const categoryLabel = EXPENSE_CATEGORIES.find((c) => c.code === category)?.name ?? category;
  const propertyLabel = OPS_HOUSES.find((h) => h.id === property)?.label ?? "Portfolio";
  const vendorLabel = OPS_PAY_VENDORS.find((v) => v.value === vendor)?.label ?? "None";
  const steps = [
    { id: "what", label: "What", summary: `${categoryLabel} · $${amount}` },
    { id: "where", label: "Where", summary: `${propertyLabel} · ${vendorLabel}` },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  return (
    <DemoWorkspacePopup
      title="Add expense"
      steps={steps}
      sidePanel={
        <PreviewPanel
          title="Expense"
          name={categoryLabel}
          facts={[
            { label: "Category", value: categoryLabel },
            { label: "Amount", value: amount ? `$${amount}` : "Not set", warn: !amount },
            { label: "Property", value: propertyLabel },
          ]}
          creates={[{ tone: "yes", text: "Saves an expense" }]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Save expense", onFinish: onSaved }}
      onClose={onClose}
      stepHeading=""
      dataAttr="finances-expense-popup"
    >
      {(step) =>
        step === 0 ? (
          <StepColumn>
            <StepHeading title="Expense" />
            <WizardSelect label="Category" value={category} onChange={setCategory} options={EXPENSE_CATEGORIES.map((c) => ({ value: c.code, label: c.name }))} />
            <WizardField label="Amount" required>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
            </WizardField>
            <WizardField label="Date">
              <Input type="date" className="portal-modal-date-input" value={date} onChange={(e) => setDate(e.target.value)} />
            </WizardField>
            <WizardField label="Description">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </WizardField>
            <div className="pt-1">
              <p className="mb-1.5 text-[12.5px] font-bold text-foreground">Tax status</p>
              <ExpenseTaxStatusToggle deductible={deductible} onChange={setDeductible} />
            </div>
          </StepColumn>
        ) : step === 1 ? (
          <StepColumn>
            <StepHeading title="Where" />
            <WizardSelect label="Property" value={property} onChange={setProperty} options={finStepOptions} />
            <WizardSelect label="Vendor" value={vendor} onChange={setVendor} options={[{ value: "", label: "None" }, ...OPS_PAY_VENDORS.map((v) => ({ value: v.value, label: v.label }))]} />
          </StepColumn>
        ) : (
          <StepColumn>
            <StepHeading title="Review" />
            <PreviewPanel
              title="Expense"
              name={categoryLabel}
              facts={[
                { label: "Amount", value: amount ? `$${amount}` : "—" },
                { label: "Property", value: propertyLabel },
                { label: "Vendor", value: vendorLabel },
              ]}
              creates={[{ tone: "yes", text: "Saves an expense" }]}
            />
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

/** Add income: What · Where · Review. */
export function DemoIncomePopup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [category, setCategory] = useState(INCOME_CATEGORIES[0]?.code ?? "rental_income");
  const [amount, setAmount] = useState("1,080.00");
  const [date, setDate] = useState("2025-09-25");
  const [description, setDescription] = useState("");
  const [property, setProperty] = useState("");
  const categoryLabel = INCOME_CATEGORIES.find((c) => c.code === category)?.name ?? category;
  const propertyLabel = OPS_HOUSES.find((h) => h.id === property)?.label ?? "Portfolio";
  const steps = [
    { id: "what", label: "What", summary: `${categoryLabel} · $${amount}` },
    { id: "where", label: "Where", summary: propertyLabel },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  return (
    <DemoWorkspacePopup
      title="Add income"
      steps={steps}
      sidePanel={
        <PreviewPanel
          title="Income"
          name={categoryLabel}
          facts={[
            { label: "Type", value: categoryLabel },
            { label: "Amount", value: amount ? `$${amount}` : "Not set", warn: !amount },
            { label: "Property", value: propertyLabel },
          ]}
          creates={[{ tone: "yes", text: "Saves an income entry" }]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Save income", onFinish: onSaved }}
      onClose={onClose}
      stepHeading=""
      dataAttr="finances-income-popup"
    >
      {(step) =>
        step === 0 ? (
          <StepColumn>
            <StepHeading title="Income" />
            <WizardSelect label="Type" value={category} onChange={setCategory} options={INCOME_CATEGORIES.map((c) => ({ value: c.code, label: c.name }))} />
            <WizardField label="Amount" required>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
            </WizardField>
            <WizardField label="Date received">
              <Input type="date" className="portal-modal-date-input" value={date} onChange={(e) => setDate(e.target.value)} />
            </WizardField>
            <WizardField label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </WizardField>
          </StepColumn>
        ) : step === 1 ? (
          <StepColumn>
            <StepHeading title="Where" />
            <WizardSelect label="Property" value={property} onChange={setProperty} options={finStepOptions} />
          </StepColumn>
        ) : (
          <StepColumn>
            <StepHeading title="Review" />
            <PreviewPanel
              title="Income"
              name={categoryLabel}
              facts={[
                { label: "Amount", value: amount ? `$${amount}` : "—" },
                { label: "Property", value: propertyLabel },
              ]}
              creates={[{ tone: "yes", text: "Saves an income entry" }]}
            />
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

const PERIOD_OPTIONS = [
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "12m", label: "Last 12 months" },
];

/** A report's page: the report's name, a period select and its table, from fixtures. Back chevron returns to Reports. */
export function DemoReportPage({ report, onBack, toast }: { report: OpsReport; onBack: () => void; toast: (text: string) => void }) {
  const [period, setPeriod] = useState("month");
  return (
    <PortalTitleActionsProvider>
      <div className="flex min-h-0 flex-col" data-attr="demo-report-page">
        <PortalDetailHeader title={report.label} subtitle={PERIOD_OPTIONS.find((p) => p.value === period)?.label} onBack={onBack} backLabel="Back to reports" hideBackText bare iconTitleActions dataAttrBack="finances-report-back" />
        <div className="space-y-3 px-1 pt-2" data-attr="finances-report-body">
          <div className="flex items-center justify-between gap-2">
            <FieldSingleSelect hideLabel variant="pill" label="Period" value={period} onChange={setPeriod} options={PERIOD_OPTIONS} dataAttr="finances-report-period" />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" className="rounded-full" onClick={() => toast("Export CSV (sample)")}>
                <Download className="size-4" aria-hidden /> CSV
              </Button>
              <Button type="button" variant="outline" className="rounded-full" onClick={() => toast("Download PDF (sample)")}>
                <Download className="size-4" aria-hidden /> PDF
              </Button>
            </div>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-accent/30 text-left text-[12px] font-semibold uppercase tracking-wide text-muted">
                  {report.columns.map((column, index) => (
                    <th key={column || index} className={cn("px-4 py-2.5", index > 0 && "text-right")}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((cells, rowIndex) => {
                  const isTotal = report.total && rowIndex === report.rows.length - 1;
                  return (
                    <tr key={rowIndex} className="border-b border-border/70 last:border-0">
                      {cells.map((cell, index) => (
                        <td key={index} className={cn("px-4 py-2.5 tabular-nums", index > 0 && "text-right", isTotal && "font-semibold text-foreground")}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </PortalTitleActionsProvider>
  );
}

/* ═════════════════════════════════ DOCUMENTS ═════════════════════════════════ */

/** Upload document: File · Details · Review. */
export function DemoUploadDocumentPopup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [fileName, setFileName] = useState<string | null>("Certificate of insurance.pdf");
  const [name, setName] = useState("Certificate of insurance");
  const [category, setCategory] = useState("Insurance");
  const [expires, setExpires] = useState("2026-09-30");
  const [property, setProperty] = useState("");
  const [visibility, setVisibility] = useState("Manager only");
  const steps = [
    { id: "file", label: "File", summary: fileName ?? "Choose a file" },
    { id: "details", label: "Details", summary: category },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  return (
    <DemoWorkspacePopup
      title="Upload document"
      steps={steps}
      sidePanel={
        <PreviewPanel
          title="Document"
          name={name.trim() || fileName || "Document"}
          facts={[
            { label: "File", value: fileName ?? "Not chosen", warn: !fileName },
            { label: "Category", value: category },
            { label: "Visibility", value: visibility },
          ]}
          creates={[{ tone: "yes", text: "Saves this document" }]}
        />
      }
      footer={{ kind: "wizard", lastLabel: "Upload", onFinish: onSaved }}
      onClose={onClose}
      dataAttr="document-upload-popup"
    >
      {(step) =>
        step === 0 ? (
          <StepColumn>
            <WorkspaceFileCard accept={DOCUMENT_UPLOAD_ACCEPT} chips={DOCUMENT_FILE_CHIPS} dataAttr="document-upload-file-card" fileName={fileName} onPick={(file) => setFileName(file?.name ?? "document.pdf")} />
            <WizardField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Document name" />
            </WizardField>
          </StepColumn>
        ) : step === 1 ? (
          <StepColumn>
            <WizardSelect label="Category" value={category} onChange={setCategory} options={toOptions(OPS_DOCUMENT_CATEGORIES)} />
            <WizardField label="Expiration">
              <Input type="date" className="portal-modal-date-input" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </WizardField>
            <WizardSelect label="Property" value={property} onChange={setProperty} options={[{ value: "", label: "Manager-level" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))]} />
            <WizardSelect label="Visibility" value={visibility} onChange={setVisibility} options={toOptions(OPS_DOCUMENT_VISIBILITY)} dataAttr="document-visibility" />
          </StepColumn>
        ) : (
          <StepColumn>
            <PreviewPanel
              title="Document"
              name={name.trim() || fileName || "Document"}
              facts={[
                { label: "File", value: fileName ?? "—" },
                { label: "Property", value: OPS_HOUSES.find((h) => h.id === property)?.label ?? "Manager-level" },
                { label: "Visibility", value: visibility },
              ]}
              creates={[{ tone: "yes", text: "Saves this document" }]}
            />
          </StepColumn>
        )
      }
    </DemoWorkspacePopup>
  );
}

/** Other documents: a row opens the preview modal titled by the file, with Edit and Download. */
export function DemoDocumentPreviewDialog({ row, onClose, toast }: { row: DocumentFixtureRow; onClose: () => void; toast: (text: string) => void }) {
  const meta = OPS_OTHER_DOCUMENTS[row.id];
  return (
    <DemoSmallDialog
      wide
      title={row.title}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" className="rounded-full" data-attr="document-preview-edit" onClick={() => toast("Edit (sample)")}>
            Edit
          </Button>
          <Button type="button" variant="outline" className="rounded-full" data-attr="document-download" onClick={() => toast("Download (sample)")}>
            Download
          </Button>
        </>
      }
    >
      <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 py-8 text-center" data-attr="document-preview-file-fallback">
        <FileText className="size-10 text-muted" aria-hidden />
        <dl className="grid grid-cols-[auto_auto] gap-x-2 gap-y-1 text-xs text-muted">
          <dt className="text-right font-medium text-foreground/70">Type</dt>
          <dd className="text-left">{meta?.type ?? "application/pdf"}</dd>
          <dt className="text-right font-medium text-foreground/70">Size</dt>
          <dd className="text-left">{meta?.size ?? ""}</dd>
          <dt className="text-right font-medium text-foreground/70">Uploaded</dt>
          <dd className="text-left">{meta?.uploaded ?? ""}</dd>
        </dl>
      </div>
    </DemoSmallDialog>
  );
}

/** A lease's inline preview, drawn under its row when the row is clicked (`DocumentInlineViewer`, embedded). */
export function DemoLeaseInlinePreview({ row, toast }: { row: DocumentFixtureRow; toast: (text: string) => void }) {
  return (
    <div className="space-y-3" data-attr="manager-documents-lease-preview">
      <div className="rounded-lg border border-border bg-white p-6 text-[12.5px] leading-relaxed text-slate-800 shadow-sm">
        <p className="mb-2 text-center text-[14px] font-bold">Residential lease agreement</p>
        <p>This lease is between Seattle Homes and {row.title}, for {row.meta.split(" · ")[0]}. Rent is due on the 1st of each month.</p>
        <p className="mt-2 text-muted">{row.meta.split(" · ").slice(1).join(" · ")}</p>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="outline" className="rounded-full" data-attr="manager-documents-lease-download" onClick={() => toast("Download (sample)")}>
          <Download className="size-4" aria-hidden /> Download PDF
        </Button>
      </div>
    </div>
  );
}

/** Documents > Applications: a row opens the application as a document (header with the applicant, then the PDF-style sheet). */
export function DemoApplicationDocRecord({ row, onBack, toast }: { row: DocumentFixtureRow; onBack: () => void; toast: (text: string) => void }) {
  const doc = OPS_APPLICATION_DOCS[row.id];
  return (
    <PortalTitleActionsProvider>
      <div className="flex min-h-0 flex-col" data-attr="demo-application-document">
        <PortalDetailHeader
          title={doc?.name ?? row.title}
          subtitle={doc?.email ?? row.trailing}
          avatarName={doc?.name ?? row.title}
          onBack={onBack}
          backLabel="Back to documents"
          hideBackText
          bare
          iconTitleActions
          dataAttrBack="documents-application-detail-back"
        />
        <div className="px-3 pb-6 pt-2 sm:px-4">
          <div className="mx-auto max-w-[720px] rounded-lg border border-border bg-white p-8 text-[13px] leading-relaxed text-slate-800 shadow-sm">
            <p className="mb-1 text-[15px] font-bold">Rental application</p>
            <p className="mb-5 text-slate-500">{doc?.place}</p>
            {[
              ["Applicant", doc?.name ?? row.title],
              ["Email", doc?.email ?? ""],
              ["Phone", doc?.phone ?? ""],
              ["Status", doc?.status ?? ""],
              ["Submitted", doc?.submitted ?? ""],
              ["Move-in", doc?.moveIn ?? ""],
              ["Income", doc?.income ?? ""],
              ["Employer", doc?.employer ?? ""],
              ["References", doc?.references ?? ""],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-slate-200 py-1.5 last:border-0">
                <span className="text-slate-500">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-3 flex max-w-[720px] justify-end">
            <Button type="button" variant="outline" className="rounded-full" onClick={() => toast("Download (sample)")}>
              <Download className="size-4" aria-hidden /> Download
            </Button>
          </div>
        </div>
      </div>
    </PortalTitleActionsProvider>
  );
}
