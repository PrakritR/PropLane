"use client";

import { useEffect, useState } from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { AUTOMATED_MESSAGE_CATALOG, automatedMessageKey, normalizeAutomatedMessageSettings, type AutomatedMessageAudience, type AutomatedMessageCatalogEntry, type AutomatedMessageSettings } from "@/lib/automated-messages-settings";
import { DEFAULT_REMINDER_RULES, REMINDER_SUBJECT_KINDS, REMINDER_SUBJECT_META, normalizeReminderSettings, type ReminderRule, type ReminderSettings, type ReminderSubjectKind } from "@/lib/reminders/rules";
import { reminderSubjectSettingsMeta } from "@/lib/reminders/subject-settings-meta";
import { formatTiming, parseTimingKey, timingOptions } from "@/lib/reminders/timings";
import { SETTINGS_MESSAGE_GROUPS, eventSettingsGroup, reminderSettingsGroup } from "@/lib/settings-message-groups";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Textarea } from "@/components/ui/textarea";
import { useAppUi } from "@/components/providers/app-ui-provider";

const AUDIENCE: Record<AutomatedMessageAudience, string> = { manager: "You", resident: "Resident", vendor: "Vendor", team: "Your team" };
const CHANNELS = [{ value: "inbox", label: "App", disabled: true }, { value: "email", label: "Email" }, { value: "sms", label: "Text" }];
const EVENT_TIMINGS = [{ value: "immediately", label: "Immediately" }, { value: "hour", label: "Within the hour" }, { value: "morning", label: "Next morning at 8 AM" }];
type MessageRow = { id: string; label: string; group: string; event?: AutomatedMessageCatalogEntry; kind?: ReminderSubjectKind };
const ROWS: MessageRow[] = [
  ...AUTOMATED_MESSAGE_CATALOG.map((event) => ({ id: `${event.domain}:${event.event}`, label: event.label, group: eventSettingsGroup(event), event })),
  ...REMINDER_SUBJECT_KINDS.filter((kind) => DEFAULT_REMINDER_RULES[kind].enabled).map((kind) => ({ id: kind, label: REMINDER_SUBJECT_META[kind].label.replace("Service orders", "Services"), group: reminderSettingsGroup(kind), kind })),
];
function selectedChannels(rule: { email?: boolean; sms?: boolean }) { return ["inbox", ...(rule.email ? ["email"] : []), ...(rule.sms ? ["sms"] : [])]; }
function ruleTimings(rule: ReminderRule, kind: ReminderSubjectKind) {
  return rule.timings?.length ? rule.timings : rule.leadMinutes.map((minutes) => `${reminderSubjectSettingsMeta(kind)?.directions[0] ?? "before"}:${Math.abs(minutes)}`);
}
function timingLabel(keys: string[]) { return keys.map((key) => { const timing = parseTimingKey(key); return timing ? formatTiming(timing) : key; }).join(", "); }

/** The editable reference is backed by the same catalogues and workspace rows as delivery. */
export function WhatProplaneSends() {
  const workspaceId = useWorkspaces()?.active?.id;
  const { showToast } = useAppUi();
  const [events, setEvents] = useState<AutomatedMessageSettings | null>(null);
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [defaults, setDefaults] = useState<Record<string, { subject: string; body: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<string[]>(["Leasing"]);
  const [editing, setEditing] = useState<MessageRow | null>(null);
  const [audience, setAudience] = useState<AutomatedMessageAudience>("resident");
  const [channels, setChannels] = useState<string[]>([]);
  const [when, setWhen] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const read = async (path: string) => {
      const response = await fetch(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load messages.");
      return body;
    };
    void Promise.all([read("/api/portal/automated-messages"), read("/api/portal/reminder-settings")]).then(([eventData, reminderData]) => {
      if (controller.signal.aborted) return;
      setEvents(normalizeAutomatedMessageSettings(eventData.settings)); setDefaults(eventData.defaults ?? {});
      setReminders(normalizeReminderSettings(reminderData.settings)); setError(null);
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [workspaceId, reload]);
  const open = (row: MessageRow, who = row.event?.audiences[0] ?? "resident") => {
    setEditing(row); setAudience(who); setEditError(null);
    if (row.kind && reminders) {
      const rule = reminders.rules[row.kind];
      const template = rule.template ?? reminderSubjectSettingsMeta(row.kind)?.defaultTemplate;
      setChannels(selectedChannels(rule)); setWhen(ruleTimings(rule, row.kind));
      setSubject(template?.subject ?? row.label); setMessage(template?.body ?? "");
    } else if (row.event) {
      const key = automatedMessageKey(row.event.domain, row.event.event, who);
      const setting = events?.[key]; const template = setting?.template ?? defaults[key];
      setChannels(selectedChannels(setting?.channels ?? { email: true, sms: false }));
      setWhen([setting?.timing ?? "immediately"]); setSubject(template?.subject ?? row.label); setMessage(template?.body ?? "");
    }
  };
  const save = async (reset = false, target = editing) => {
    if (!target || !workspaceId || busy) return;
    setBusy(true); setEditError(null);
    try {
      let payload: Record<string, unknown>;
      if (target.kind && reminders) {
        const rule = reset ? DEFAULT_REMINDER_RULES[target.kind] : { ...reminders.rules[target.kind], inbox: true, email: channels.includes("email"), sms: channels.includes("sms"), timings: when, template: { subject, body: message } };
        payload = { workspaceId, kind: target.kind, rule };
      } else if (target.event) {
        const who = reset ? target.event.audiences : [audience];
        const settings = Object.fromEntries(who.map((recipient) => {
          const key = automatedMessageKey(target.event!.domain, target.event!.event, recipient);
          return [key, reset ? { enabled: true } : { ...events?.[key], enabled: events?.[key]?.enabled ?? true, channels: { email: channels.includes("email"), sms: channels.includes("sms") }, timing: when[0], template: { subject, body: message } }];
        }));
        payload = { workspaceId, settings };
      } else return;
      const response = await fetch(target.kind ? "/api/portal/reminder-settings" : "/api/portal/automated-messages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save message.");
      if (target.kind) setReminders(normalizeReminderSettings(body.settings)); else setEvents(normalizeAutomatedMessageSettings(body.settings));
      setEditing(null); showToast("Saved");
    } catch (e) { setEditError(e instanceof Error ? e.message : "Could not save message."); }
    finally { setBusy(false); }
  };
  const ready = Boolean(events && reminders && !error);
  return <section className="space-y-3" data-attr="what-proplane-sends">
    <h2 className="text-xl font-semibold">What PropLane sends</h2>
    {error ? <p role="alert" className="text-sm text-danger">{error} <button onClick={() => setReload((v) => v + 1)}>Retry</button></p> : !ready ? <p role="status" className="text-sm text-muted">Loading…</p> : null}
    {SETTINGS_MESSAGE_GROUPS.map((group) => {
      const rows = ROWS.filter((row) => row.group === group); const isOpen = expanded.includes(group);
      return <section key={group} className="space-y-2">
        <button type="button" className="flex min-h-11 w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted" aria-expanded={isOpen} onClick={() => setExpanded((current) => isOpen ? current.filter((item) => item !== group) : [...current, group])}>
          {group}<span>{rows.length}</span><ChevronRight className={`h-3.5 w-3.5 ${isOpen ? "rotate-90" : ""}`} />
        </button>
        {isOpen ? <PortalSettingsGroup>{rows.map((row) => {
          const rule = row.kind ? reminders?.rules[row.kind] ?? DEFAULT_REMINDER_RULES[row.kind] : null;
          const event = row.event; const setting = event ? events?.[automatedMessageKey(event.domain, event.event, event.audiences[0]!)] : null;
          const who = event ? event.audiences.map((a) => AUDIENCE[a]).join(" · ") : rule && row.kind ? [rule.audience.manager ? "You" : "", rule.audience.team ? "Your team" : "", rule.audience.counterparty ? REMINDER_SUBJECT_META[row.kind].counterpartyLabel : "", rule.audience.vendor ? "Vendor" : ""].filter(Boolean).join(" · ") : "";
          const timing = rule && row.kind ? timingLabel(ruleTimings(rule, row.kind)) : EVENT_TIMINGS.find((option) => option.value === setting?.timing)?.label ?? "Immediately";
          const channelText = selectedChannels(rule ?? setting?.channels ?? { email: true }).map((value) => CHANNELS.find((c) => c.value === value)?.label).join(", ");
          return <div key={row.id} className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2 last:border-0">
            <div className="min-w-0 flex-1"><p className="text-[15px]">{row.label}</p><p className="text-[13px] text-muted">{who} · {channelText}<span className="sm:hidden"> · {timing}</span></p></div>
            <span className="hidden max-w-[40%] text-right text-[15px] text-muted sm:block">{timing}</span>
            <DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${row.label} actions`} disabled={!ready || busy} /></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => open(row)}>Edit</DropdownMenuItem><DropdownMenuItem onSelect={() => { open(row); void save(true, row); }}>Reset to default</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </div>;
        })}</PortalSettingsGroup> : null}
      </section>;
    })}
    <PortalDialog open={editing !== null} onClose={() => { if (!busy) setEditing(null); }} title={editing?.label ?? "Message"} primaryAction={{ label: "Save message", onClick: () => save(), disabled: busy || !message.trim() || !when.length }}>
      <div className="space-y-4">
        {editing?.event && editing.event.audiences.length > 1 ? <FieldSingleSelect label="Recipient" value={audience} options={editing.event.audiences.map((value) => ({ value, label: AUDIENCE[value] }))} onChange={(value) => open(editing, value as AutomatedMessageAudience)} /> : null}
        <CheckboxMultiSelect label="Channels" selected={channels} options={CHANNELS} onChange={(next) => setChannels([...new Set(["inbox", ...next])])} />
        {editing?.kind ? <CheckboxMultiSelect label="When" selected={when} options={[...when.filter((key) => !timingOptions(reminderSubjectSettingsMeta(editing.kind!)?.directions ?? ["before"]).some((option) => option.value === key)).map((value) => ({ value, label: timingLabel([value]) })), ...timingOptions(reminderSubjectSettingsMeta(editing.kind)?.directions ?? ["before"])]} onChange={setWhen} /> : <FieldSingleSelect label="When" value={when[0] ?? "immediately"} options={EVENT_TIMINGS} onChange={(value) => setWhen([value])} />}
        <label className="block space-y-2 text-xs font-medium uppercase text-muted">Message<Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={7} /></label>
        {editError ? <p role="alert" className="text-sm text-danger">{editError}</p> : null}
      </div>
    </PortalDialog>
  </section>;
}
