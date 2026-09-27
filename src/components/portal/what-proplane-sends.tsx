"use client";

/**
 * Settings → Notifications → What PropLane sends (WS4, PLAN-0925 Part 5 / C190).
 *
 * A single READ-ONLY reference: every automated message and every timed
 * reminder this workspace can send, who hears it, and how. Built entirely
 * from `AUTOMATED_MESSAGE_CATALOG` (the event catalogue `emitActionEvent`
 * actually applies) and `DEFAULT_REMINDER_RULES` / `REMINDER_SUBJECT_META`
 * (the same defaults the reminder dispatcher actually sends) — never a
 * separately maintained description, so this page can never drift from what
 * is actually sent. No fetch, no edit control: per C192 the wording and
 * timing shown here are fixed, using the workspace's own renamed terms
 * wherever `emitActionEvent`'s templates already do.
 *
 * Per-event/per-kind toggles still live on their owning area tab (Settings →
 * that area) for now — this page is the map of the defaults, not a second
 * copy of their controls.
 */
import {
  AUTOMATED_MESSAGE_CATALOG,
  type AutomatedMessageAudience,
  type AutomatedMessageCatalogEntry,
} from "@/lib/automated-messages-settings";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_KINDS,
  REMINDER_SUBJECT_META,
  VENDOR_AUDIENCE_KINDS,
  formatLeadSummary,
  type ReminderRule,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";

const AREA_LABEL: Record<AutomatedMessageCatalogEntry["area"], string> = {
  services: "Services & vendors",
  lease: "Lease, move-in & move-out",
  payments: "Payments",
  applications: "Applications",
  tours: "Tours",
  inspections: "Inspections",
  tasks: "Tasks",
  communication: "Communication",
};

const AREA_ORDER: AutomatedMessageCatalogEntry["area"][] = [
  "tours",
  "applications",
  "lease",
  "payments",
  "services",
  "inspections",
  "tasks",
  "communication",
];

const AUDIENCE_LABEL: Record<AutomatedMessageAudience, string> = {
  manager: "You",
  resident: "Resident",
  vendor: "Vendor",
  team: "Your team",
};

function whoForAudiences(audiences: readonly AutomatedMessageAudience[]): string {
  return audiences.map((audience) => AUDIENCE_LABEL[audience]).join(" · ");
}

function whoForRule(kind: ReminderSubjectKind, rule: ReminderRule): string {
  const meta = REMINDER_SUBJECT_META[kind];
  const parts: string[] = [];
  if (rule.audience.manager) parts.push("You");
  if (rule.audience.team) parts.push("Your team");
  if (rule.audience.counterparty) {
    const label = meta.counterpartyLabel;
    parts.push(label.charAt(0).toUpperCase() + label.slice(1));
  }
  if (VENDOR_AUDIENCE_KINDS.has(kind) && rule.audience.vendor) parts.push("Vendor");
  return parts.length ? parts.join(" · ") : "—";
}

/** "Portal · email" / "Portal · email · text" — always portal-first, since the inbox thread is the record. */
function howForChannels(channels: { inbox: boolean; email: boolean; sms: boolean }): string {
  const parts: string[] = [];
  if (channels.inbox) parts.push("Portal");
  if (channels.email) parts.push("Email");
  if (channels.sms) parts.push("Text");
  return parts.length ? parts.join(" · ") : "Portal only";
}

function CatalogRow({ entry }: { entry: AutomatedMessageCatalogEntry }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-sm last:border-0">
      <span className="min-w-0 truncate font-medium text-foreground">{entry.label}</span>
      <span className="shrink-0 text-right text-muted">
        {whoForAudiences(entry.audiences)}
        <span className="mx-1.5 text-border">·</span>
        Portal · email
      </span>
    </div>
  );
}

function ReminderRow({ kind }: { kind: ReminderSubjectKind }) {
  const meta = REMINDER_SUBJECT_META[kind];
  const rule = DEFAULT_REMINDER_RULES[kind];
  if (!rule.enabled) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-sm last:border-0">
      <span className="min-w-0 truncate font-medium text-foreground">{meta.label}</span>
      <span className="shrink-0 text-right text-muted">
        {formatLeadSummary(rule.leadMinutes)}
        <span className="mx-1.5 text-border">·</span>
        {whoForRule(kind, rule)}
        <span className="mx-1.5 text-border">·</span>
        {howForChannels(rule)}
      </span>
    </div>
  );
}

export function WhatProplaneSends() {
  const reminderKinds = REMINDER_SUBJECT_KINDS.filter((kind) => DEFAULT_REMINDER_RULES[kind].enabled);
  return (
    <div className="space-y-8">
      <PortalSettingsSection title="Timed reminders">
        <PortalSettingsGroup>
          {reminderKinds.map((kind) => (
            <ReminderRow key={kind} kind={kind} />
          ))}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {AREA_ORDER.map((area) => {
        const entries = AUTOMATED_MESSAGE_CATALOG.filter((entry) => entry.area === area);
        if (entries.length === 0) return null;
        return (
          <PortalSettingsSection key={area} title={AREA_LABEL[area]}>
            <PortalSettingsGroup>
              {entries.map((entry) => (
                <CatalogRow key={`${entry.domain}:${entry.event}`} entry={entry} />
              ))}
            </PortalSettingsGroup>
          </PortalSettingsSection>
        );
      })}
    </div>
  );
}
