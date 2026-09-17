"use client";

/**
 * The vendor page — Profile · Messages · Check-ins · Jobs.
 *
 * Everything here autosaves: one `useAutosaveDraft` over the editable subset of
 * the row, one Saved mark in the header. The pure rules live in
 * `vendor-messaging.ts` and `vendor-check-ins.ts`; this file only draws them.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal-styles";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { SaveStatus } from "@/components/ui/save-status";
import { useAutosaveDraft } from "@/hooks/use-autosave-draft";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import {
  persistManagerVendorToServer,
  readManagerVendorCategorySettings,
  saveManagerVendorCategorySettings,
  upsertManagerVendor,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  cadenceId,
  cadenceLabel,
  makeVendorCheckInId,
  nextCheckInAt,
  VENDOR_CHECK_IN_CADENCE_OPTIONS,
  WEEKDAY_LABELS,
  type VendorCheckIn,
  type VendorCheckInOnNoOrSilent,
} from "@/lib/vendor-check-ins";
import {
  estimateSmsSegments,
  normalizeVendorMessaging,
  renderVendorMessage,
  resolveVendorChannel,
  unknownVendorMessageTokens,
  VENDOR_CHANNELS,
  VENDOR_MESSAGE_EVENT_META,
  VENDOR_MESSAGE_EVENTS,
  vendorChannelLabel,
  vendorTemplateFor,
  type VendorChannel,
  type VendorMessageEvent,
  type VendorMessaging,
} from "@/lib/vendor-messaging";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import { cn } from "@/lib/utils";

export type VendorDetailTab = "overview" | "profile" | "jobs" | "check-ins" | "communication";

/** The editable subset of a vendor row. Everything else on the row is left untouched by a save. */
type VendorDraft = {
  name: string;
  preferredName: string;
  trade: string;
  trades: string[];
  phone: string;
  email: string;
  notes: string;
  preferredLanguage: string;
  preferredChannel: VendorChannel;
  active: boolean;
  propertyIds: string[];
  defaultForTrades: string[];
  messaging: VendorMessaging;
  checkIns: VendorCheckIn[];
};

function draftFromRow(row: ManagerVendorRow, defaultForTrades: string[]): VendorDraft {
  const trades = row.trades?.length ? row.trades : row.trade ? [row.trade] : [];
  return {
    name: row.name ?? "",
    preferredName: row.preferredName ?? "",
    trade: row.trade ?? trades[0] ?? "",
    trades,
    phone: row.phone ?? "",
    email: row.email ?? "",
    notes: row.notes ?? "",
    preferredLanguage: row.preferredLanguage ?? "en",
    preferredChannel: row.preferredChannel ?? "sms",
    active: row.active !== false,
    propertyIds: row.propertyIds ?? [],
    defaultForTrades,
    messaging: normalizeVendorMessaging(row.messaging),
    checkIns: row.checkIns ?? [],
  };
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  dataAttr,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-attr={dataAttr}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[21px] w-[36px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-[2.5px] h-4 w-4 rounded-full bg-white transition-all",
          checked ? "right-[2.5px]" : "left-[2.5px]",
        )}
      />
    </button>
  );
}

export function ChipSelect({
  options,
  value,
  onChange,
  multiple = true,
  dataAttr,
}: {
  options: readonly { id: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  dataAttr?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-attr={dataAttr}>
      {options.map((opt) => {
        const on = value.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (multiple) onChange(on ? value.filter((v) => v !== opt.id) : [...value, opt.id]);
              else onChange(on ? [] : [opt.id]);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChannelSegments({
  value,
  onChange,
  dataAttr,
}: {
  value: VendorChannel;
  onChange: (next: VendorChannel) => void;
  dataAttr?: string;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-full bg-muted/60 p-0.5" data-attr={dataAttr}>
      {VENDOR_CHANNELS.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
            value === c.id ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground",
          )}
        >
          {c.short}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, help, className }: { label: string; children: ReactNode; help?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className={MODAL_FIELD_LABEL_CLASS}>{label}</span>
      {children}
      {help ? <p className="text-xs text-muted">{help}</p> : null}
    </div>
  );
}

const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
] as const;

function greeting(language: string, name: string): string {
  return language === "es" ? `Hola ${name}` : `Hi ${name}`;
}

function jobLabel(row: DemoManagerWorkOrderRow): { status: string; tone: "ok" | "warn" | "mut" } {
  if (row.bucket === "completed" || /done|complete/i.test(row.status ?? "")) return { status: "Done", tone: "ok" };
  if (row.scheduledAtIso) return { status: `Scheduled · ${formatPacificDateTime(row.scheduledAtIso)}`, tone: "mut" };
  return { status: "Assigned · no time yet", tone: "warn" };
}

export function ManagerVendorDetail({
  row,
  managerUserId,
  tab: tabProp,
  extraNeedsYou = [],
  onEdit: _onEdit,
  onSendCheckInNow,
}: {
  row: ManagerVendorRow;
  managerUserId: string | null;
  tab?: VendorDetailTab;
  extraNeedsYou?: readonly { id: string; title: string; detail: string }[];
  onEdit?: () => void;
  /** Slice E wires the real send; until then the button is hidden when absent. */
  onSendCheckInNow?: (checkIn: VendorCheckIn) => Promise<void>;
}) {
  const tab = tabProp ?? "overview";
  const messaging = useManagerMessagingNumberStatus();
  const smsAvailable = Boolean(messaging.status?.sendingAvailable && messaging.status?.number);

  const initialDefaults = useMemo(() => {
    const map = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade;
    return Object.entries(map)
      .filter(([, id]) => id === row.id)
      .map(([trade]) => trade);
    // The row id is the identity; re-reading on every row change is what we want.
  }, [managerUserId, row.id]);

  const [draft, setDraft] = useState<VendorDraft>(() => draftFromRow(row, initialDefaults));
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setDraft(draftFromRow(row, initialDefaults));
    setHydrated(false);
    const t = setTimeout(() => setHydrated(true), 0);
    return () => clearTimeout(t);
    // Re-hydrate only when the record changes identity, not on every server echo
    // of our own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const patch = useCallback((next: Partial<VendorDraft>) => setDraft((d) => ({ ...d, ...next })), []);

  const persist = useCallback(
    async (d: VendorDraft) => {
      if (!managerUserId) throw new Error("Not signed in.");
      const now = new Date().toISOString();
      const nextRow: ManagerVendorRow = {
        ...row,
        name: d.name.trim(),
        preferredName: d.preferredName.trim() || undefined,
        trade: d.trades[0] ?? d.trade.trim() ?? VENDOR_TRADE_OPTIONS[0],
        trades: d.trades.length ? d.trades : undefined,
        phone: d.phone.trim(),
        email: d.email.trim(),
        notes: d.notes.trim(),
        preferredLanguage: d.preferredLanguage,
        preferredChannel: d.preferredChannel,
        active: d.active,
        propertyIds: d.propertyIds.length ? d.propertyIds : undefined,
        messaging: d.messaging,
        checkIns: d.checkIns,
        updatedAt: now,
      };
      upsertManagerVendor(nextRow, managerUserId);
      const settings = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade;
      const nextSettings = { ...settings };
      for (const trade of Object.keys(nextSettings)) {
        if (nextSettings[trade] === row.id && !d.defaultForTrades.includes(trade)) delete nextSettings[trade];
      }
      for (const trade of d.defaultForTrades) nextSettings[trade] = row.id;
      if (JSON.stringify(nextSettings) !== JSON.stringify(settings)) {
        saveManagerVendorCategorySettings({ defaultVendorIdByTrade: nextSettings }, managerUserId);
      }
      const ok = await persistManagerVendorToServer(nextRow);
      if (!ok) throw new Error("Could not save vendor.");
    },
    [managerUserId, row],
  );

  const autosave = useAutosaveDraft({
    draft,
    enabled: hydrated && Boolean(managerUserId),
    validate: (d) => (d.name.trim() ? null : "Needs a name"),
    save: persist,
  });

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(managerUserId).map((o) => ({ id: o.id, label: o.label })),
    [managerUserId],
  );

  // Jobs: work orders assigned to this vendor.
  const [woTick, setWoTick] = useState(0);
  useEffect(() => {
    void syncManagerWorkOrdersFromServer().catch(() => undefined);
    const onChange = () => setWoTick((n) => n + 1);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, onChange);
  }, []);
  const jobs = useMemo(() => {
    void woTick;
    return readManagerWorkOrderRows().filter(
      (wo) => wo.vendorId === row.id || (wo.assignee?.type === "vendor" && wo.assignee.id === row.id),
    );
  }, [woTick, row.id]);
  const openJobs = jobs.filter((j) => jobLabel(j).status !== "Done");

  const callName = draft.preferredName.trim() || draft.name.trim().split(" ")[0] || "there";
  const reach = resolveVendorChannel({
    preferred: draft.preferredChannel,
    phone: draft.phone,
    email: draft.email,
    vendorUserId: row.vendorUserId,
    smsAvailable,
  });

  const fact = (label: string, value: string) => (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="min-w-0 truncate text-right text-[13.5px]">{value || "—"}</span>
    </div>
  );

  const profileFacts = (
    <div className="px-3 pb-4 sm:px-4" data-attr="vendor-profile-facts">
      {fact("Name", draft.name)}
      {fact("Call them", callName)}
      {fact("Trades", draft.trades.join(", "))}
      {fact("Phone", draft.phone)}
      {fact("Email", draft.email)}
      {fact("Reach them by", vendorChannelLabel(reach.channel))}
      {fact("Language", draft.preferredLanguage === "es" ? "Español" : "English")}
      {fact("Status", draft.active ? "Active" : "Inactive")}
      {fact("Portal account", row.vendorUserId ? "Signed up" : row.invitedAt ? `Invite sent ${formatPacificDateTime(row.invitedAt)}` : "Not invited")}
      {fact("Properties", draft.propertyIds.length ? propertyOptions.filter((o) => draft.propertyIds.includes(o.id)).map((o) => o.label).join(", ") : "Every property")}
      {draft.notes.trim() ? fact("Notes", draft.notes) : null}
    </div>
  );

  return (
    <div className="space-y-3" data-attr="vendor-detail">
      {tab === "overview" || tab === "profile" ? (
        <div className="flex items-center justify-end px-3 sm:px-4">
          <SaveStatus status={autosave} />
        </div>
      ) : (
        <div className="flex items-center justify-end px-3 sm:px-4">
          <SaveStatus status={autosave} />
        </div>
      )}

      {tab === "overview" ? (
        <div className="space-y-4 px-3 pb-4 sm:px-4" data-attr="vendor-overview">
          {extraNeedsYou.length ? (
            <div className="space-y-2" data-attr="vendor-needs-you">
              <h2 className="text-sm font-semibold">Needs you</h2>
              {extraNeedsYou.map((item) => (
                <div key={item.id} className="rounded-xl border border-border bg-card px-3 py-2.5">
                  <p className="text-[13.5px] font-medium">{item.title}</p>
                  <p className="text-[13px]">{item.detail}</p>
                </div>
              ))}
            </div>
          ) : null}
          {profileFacts}
          {openJobs.length ? (
            <p className="text-[13.5px]">{openJobs.length} open {openJobs.length === 1 ? "job" : "jobs"}</p>
          ) : null}
        </div>
      ) : null}

      {tab === "profile" ? profileFacts : null}

      {tab === "communication" ? (
        <VendorMessagesTab
          draft={draft}
          callName={callName}
          reach={reach}
          sampleJob={jobs[0] ?? null}
          onChange={(messaging) => patch({ messaging })}
        />
      ) : null}

      {tab === "check-ins" ? (
        <VendorCheckInsTab
          checkIns={draft.checkIns}
          callName={callName}
          language={draft.preferredLanguage}
          defaultChannel={draft.preferredChannel}
          reach={reach}
          propertyOptions={propertyOptions}
          onChange={(checkIns) => patch({ checkIns })}
          onSendNow={onSendCheckInNow}
        />
      ) : null}

      {tab === "jobs" ? (
        <div className="px-3 pb-4 sm:px-4">
          {jobs.length === 0 ? (
            <p className="py-8 text-center text-sm">No services assigned to {callName} yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {jobs.map((job) => {
                const l = jobLabel(job);
                return (
                  <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{job.title}</p>
                      <p className="truncate text-[13px]">
                        {[job.propertyName, job.unit, job.residentName].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 text-[13px]">{l.status}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function VendorMessagesTab({
  draft,
  callName,
  reach,
  sampleJob,
  onChange,
}: {
  draft: VendorDraft;
  callName: string;
  reach: ReturnType<typeof resolveVendorChannel>;
  sampleJob: DemoManagerWorkOrderRow | null;
  onChange: (next: VendorMessaging) => void;
}) {
  const [previewEvent, setPreviewEvent] = useState<VendorMessageEvent>("visit_scheduled");
  const ctx = useMemo(
    () => ({
      vendor: callName,
      service: sampleJob?.title || "Kitchen faucet drip",
      property: sampleJob?.propertyName || "The Pioneer",
      unit: sampleJob?.unit || "Room 8B",
      resident_first: (sampleJob?.residentName || "Liam Foster").split(" ")[0],
      visit_time: "Mon, Sep 14 · 10:00 AM",
      priority: sampleJob?.priority || "Medium",
      notes: sampleJob?.description || "",
      cost: sampleJob?.cost && sampleJob.cost !== "—" ? sampleJob.cost : "$140",
    }),
    [callName, sampleJob],
  );
  const preview = renderVendorMessage(vendorTemplateFor(draft.messaging, previewEvent).body, ctx);
  const setTemplate = (event: VendorMessageEvent, next: { enabled?: boolean; body?: string }) => {
    const current = draft.messaging.templates[event] ?? { enabled: true, body: "" };
    onChange({ ...draft.messaging, templates: { ...draft.messaging.templates, [event]: { ...current, ...next } } });
  };

  return (
    <div className="space-y-4 px-3 pb-4 sm:px-4">
      <Field
        label="Instructions for every message"
        help="Read by the assistant when it drafts or answers on your behalf. Your own words — keep it to what matters."
      >
        <Textarea
          rows={3}
          value={draft.messaging.instructions}
          onChange={(e) => onChange({ ...draft.messaging, instructions: e.target.value })}
          placeholder="Always Spanish. Keep it short — reads on the road. Never before 7am or after 8pm. Ask for a reply of OK."
          data-attr="vendor-messaging-instructions"
        />
      </Field>

      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">What {callName} gets, step by step</p>
        <div className="space-y-2">
          {VENDOR_MESSAGE_EVENTS.map((event) => {
            const meta = VENDOR_MESSAGE_EVENT_META[event];
            const t = vendorTemplateFor(draft.messaging, event);
            const own = draft.messaging.templates[event]?.body ?? "";
            const unknown = unknownVendorMessageTokens(own);
            return (
              <div key={event} className={cn("rounded-xl border border-border p-3", !t.enabled && "opacity-70")} data-attr={`vendor-template-${event}`}>
                <div className="flex items-center gap-2.5">
                  <Toggle checked={t.enabled} onChange={(enabled) => setTemplate(event, { enabled })} label={`${meta.label} on`} />
                  <button type="button" className="text-sm font-semibold text-foreground" onClick={() => setPreviewEvent(event)}>
                    {meta.label}
                  </button>
                  <span className="text-xs text-muted">· {meta.when}</span>
                </div>
                <Textarea
                  rows={2}
                  className="mt-2"
                  value={own}
                  onChange={(e) => setTemplate(event, { body: e.target.value })}
                  onFocus={() => setPreviewEvent(event)}
                  placeholder={t.body}
                  data-attr={`vendor-template-${event}-body`}
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {meta.variables.map((v) => (
                    <code key={v} className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{`{${v}}`}</code>
                  ))}
                  {!own.trim() ? <span className="ml-1 text-[11px] text-muted">Blank = the built-in wording shown above.</span> : null}
                  {unknown.length ? (
                    <span className="ml-1 text-[11px] text-amber-700">
                      {unknown.map((u) => `{${u}}`).join(", ")} is not a variable and will be sent as typed.
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          Access codes are never a variable — {callName} asks the assistant once assigned and the visit is booked.
        </p>
      </div>

      <div className="flex items-start gap-3">
        <p className="pt-2 text-xs text-muted">Preview →</p>
        <div className="max-w-sm rounded-2xl rounded-bl-md bg-primary/10 px-3 py-2 text-sm text-foreground" data-attr="vendor-message-preview">
          {preview}
          <p className="mt-1 text-[11px] text-muted">
            {VENDOR_MESSAGE_EVENT_META[previewEvent].label} · as {vendorChannelLabel(reach.channel).toLowerCase()}
            {reach.channel === "sms" ? ` · ${estimateSmsSegments(preview)} segment${estimateSmsSegments(preview) === 1 ? "" : "s"}` : ""}
            {reach.note ? ` · ${reach.note}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  id: String(h),
  label: `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`,
}));

const ON_NO_OPTIONS: { id: VendorCheckInOnNoOrSilent; label: string }[] = [
  { id: "task", label: "Create a task for me, due next morning" },
  { id: "inbox", label: "Notify me in the inbox" },
  { id: "log", label: "Just log it" },
];

function VendorCheckInsTab({
  checkIns,
  callName,
  language,
  defaultChannel,
  reach,
  propertyOptions,
  onChange,
  onSendNow,
}: {
  checkIns: VendorCheckIn[];
  callName: string;
  language: string;
  defaultChannel: VendorChannel;
  reach: ReturnType<typeof resolveVendorChannel>;
  propertyOptions: { id: string; label: string }[];
  onChange: (next: VendorCheckIn[]) => void;
  onSendNow?: (checkIn: VendorCheckIn) => Promise<void>;
}) {
  const [adding, setAdding] = useState(checkIns.length === 0);
  const [question, setQuestion] = useState("");
  const [cadence, setCadence] = useState("biweekly");
  const [weekday, setWeekday] = useState(1);
  const [hour, setHour] = useState(9);
  const [channel, setChannel] = useState<VendorChannel>(defaultChannel);
  const [propertyId, setPropertyId] = useState("");
  const [onNo, setOnNo] = useState<VendorCheckInOnNoOrSilent>("task");
  const [sendingId, setSendingId] = useState<string | null>(null);

  const update = (id: string, next: Partial<VendorCheckIn>) =>
    onChange(checkIns.map((c) => (c.id === id ? { ...c, ...next } : c)));

  const add = () => {
    const q = question.trim();
    if (!q) return;
    const cad = VENDOR_CHECK_IN_CADENCE_OPTIONS.find((o) => o.id === cadence)?.cadence ?? "biweekly";
    const now = new Date();
    const next: VendorCheckIn = {
      id: makeVendorCheckInId(),
      question: q,
      cadence: cad,
      weekday,
      hour,
      minute: 0,
      channel,
      propertyId: propertyId || null,
      enabled: true,
      onNoOrSilent: onNo,
      anchorDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      createdAt: now.toISOString(),
      log: [],
    };
    onChange([...checkIns, next]);
    setQuestion("");
    setAdding(false);
  };

  return (
    <div className="space-y-4 px-3 pb-4 sm:px-4">
      {checkIns.length === 0 && !adding ? (
        <p className="py-4 text-center text-sm text-muted">No check-ins yet.</p>
      ) : null}
      {checkIns.map((c) => {
        const next = nextCheckInAt(c);
        const last = c.log.at(-1);
        return (
          <div key={c.id} className="rounded-xl border border-border" data-attr="vendor-check-in">
            <div className="flex items-start gap-3 px-3 py-3">
              <Toggle checked={c.enabled} onChange={(enabled) => update(c.id, { enabled })} label="Check-in on" dataAttr="vendor-check-in-enabled" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">“{c.question}”</p>
                <p className="text-xs text-muted">
                  {cadenceLabel(c.cadence)}
                  {typeof c.cadence === "string" ? ` · ${WEEKDAY_LABELS[c.weekday]}` : ""} · {HOURS[c.hour]?.label} ·{" "}
                  {vendorChannelLabel(c.channel ?? defaultChannel)}
                  {next && c.enabled ? (
                    <>
                      {" "}
                      · next <span className="font-semibold text-foreground">{formatPacificDateTime(new Date(next).toISOString())}</span>
                    </>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {c.onNoOrSilent === "task"
                    ? "If “no” or no reply by the next morning → a task for you."
                    : c.onNoOrSilent === "inbox"
                      ? "If “no” or no reply by the next morning → a note in your inbox."
                      : "Replies are logged; nothing else happens."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {onSendNow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full px-3 py-1 text-xs"
                    disabled={sendingId === c.id || !reach.channel}
                    data-attr="vendor-check-in-send-now"
                    onClick={async () => {
                      setSendingId(c.id);
                      try {
                        await onSendNow(c);
                      } finally {
                        setSendingId(null);
                      }
                    }}
                  >
                    {sendingId === c.id ? "Sending…" : "Send now"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  data-attr="vendor-check-in-remove"
                  onClick={() => onChange(checkIns.filter((x) => x.id !== c.id))}
                >
                  Remove
                </Button>
              </div>
            </div>
            {c.log.length ? (
              <div className="border-t border-border px-3 py-2">
                <p className="mb-1 text-xs font-semibold text-foreground">Replies</p>
                <ul className="space-y-1 text-xs">
                  {c.log
                    .slice()
                    .reverse()
                    .slice(0, 6)
                    .map((e) => (
                      <li key={e.sentAt} className="flex flex-wrap items-center gap-2">
                        <span className="w-32 shrink-0 text-muted">{formatPacificDateTime(e.sentAt)}</span>
                        {e.reply ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                                e.reply.verdict === "yes" && "bg-emerald-50 text-emerald-700",
                                e.reply.verdict === "no" && "bg-rose-50 text-rose-700",
                                e.reply.verdict === "unclear" && "bg-amber-50 text-amber-700",
                              )}
                            >
                              {e.reply.verdict === "yes" ? "Yes" : e.reply.verdict === "no" ? "No" : "Unclear"}
                            </span>
                            <span className="truncate text-foreground/90">“{e.reply.text}”</span>
                          </>
                        ) : e.ruleRanAt ? (
                          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">No reply{e.taskId ? " → task created" : ""}</span>
                        ) : (
                          <span className="text-muted">Waiting for a reply</span>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ) : last ? null : null}
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-xl border border-dashed border-border p-3" data-attr="vendor-check-in-form">
          <p className="mb-3 text-sm font-semibold text-foreground">New check-in</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Question"
              className="sm:col-span-2"
              help={`Sent as written, after “${greeting(language, callName)} —”. Variables: {vendor} {property}.`}
            >
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={language === "es" ? "¿Limpiaste hoy?" : "Did you clean today?"}
                data-attr="vendor-check-in-question"
              />
            </Field>
            <Field label="Every">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value)} data-attr="vendor-check-in-cadence">
                {VENDOR_CHECK_IN_CADENCE_OPTIONS.map((o) => (
                  <option key={o.id} value={cadenceId(o.cadence)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On">
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={String(weekday)}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                  disabled={cadence.startsWith("every") && !["weekly", "biweekly", "monthly"].includes(cadence)}
                  data-attr="vendor-check-in-weekday"
                >
                  {WEEKDAY_LABELS.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </Select>
                <Select value={String(hour)} onChange={(e) => setHour(Number(e.target.value))} data-attr="vendor-check-in-hour">
                  {HOURS.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Channel">
              <ChannelSegments value={channel} onChange={setChannel} dataAttr="vendor-check-in-channel" />
            </Field>
            {propertyOptions.length ? (
              <Field label="Property (optional)">
                <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} data-attr="vendor-check-in-property">
                  <option value="">All of {callName}&apos;s</option>
                  {propertyOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="If “no” or no reply" className="sm:col-span-2">
              <Select value={onNo} onChange={(e) => setOnNo(e.target.value as VendorCheckInOnNoOrSilent)} data-attr="vendor-check-in-on-no">
                {ON_NO_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {checkIns.length ? (
              <Button type="button" variant="outline" className="rounded-full" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="button" variant="primary" className="rounded-full" disabled={!question.trim()} onClick={add} data-attr="vendor-check-in-add">
              Add check-in
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="w-full rounded-xl border-2 border-dashed border-border py-2.5 text-sm font-semibold text-muted hover:border-foreground/30 hover:text-foreground"
          onClick={() => setAdding(true)}
          data-attr="vendor-check-in-new"
        >
          + Add check-in
        </button>
      )}
    </div>
  );
}
