"use client";

/**
 * Service settings (C108) — a real modal, opened from the Services list's
 * gear icon, never a link-out. Content is deliberately narrow: a button to
 * the real service-catalog editor, plus a READ-ONLY summary of the four
 * escalation rules that govern the Services queue (unassigned / unassigned
 * emergency / add-on awaiting decision / approved-but-unpaid). Editing those
 * timings, audiences and templates in full stays reachable at
 * Settings -> Notifications -> Services (`ServicesSettingsPanel`,
 * `pro-portal-settings-panels.tsx`) — this modal removes nothing, it just
 * gives the Services list a lighter entry point that matches the "escalation
 * rules + a link to the catalog" shape from the studio mock
 * (`~/proplane-mock-kit/proto/m-tenancy.js` `tenancy.serviceSettings`).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_META,
  normalizeReminderSettings,
  type ReminderAudience,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { formatTiming, parseTimingKey } from "@/lib/reminders/timings";

/** The Services queue's own escalation rules, in the order the mock lists them. */
const SERVICE_ESCALATION_KINDS: ReminderSubjectKind[] = [
  "work_order_unassigned",
  "work_order_unassigned_emergency",
  "service_request_decision",
  "service_request_unpaid",
];

function audienceSummary(kind: ReminderSubjectKind, audience: ReminderAudience): string {
  const who: string[] = [];
  if (audience.manager) who.push("you");
  if (audience.team) who.push("team");
  if (audience.counterparty) who.push(REMINDER_SUBJECT_META[kind].counterpartyLabel);
  if (audience.vendor) who.push("vendor");
  return who.length > 0 ? `notify ${who.join(" + ")}` : "no notification";
}

export function ServiceEscalationSettingsModal({
  open,
  onClose,
  onEditCatalog,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens the real service-catalog editor (types and pricing per property). */
  onEditCatalog: () => void;
}) {
  const demo = isDemoModeActive();
  const [rules, setRules] = useState(DEFAULT_REMINDER_RULES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setRules(DEFAULT_REMINDER_RULES);
          return;
        }
        const res = await fetch("/api/portal/reminder-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown };
        if (!cancelled && res.ok) setRules(normalizeReminderSettings(body.settings).rules);
      } catch {
        // Read-only summary — leaving it on defaults on a failed read is safe;
        // the real editor (Settings -> Notifications -> Services) is the
        // source of truth and re-reads independently.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, demo]);

  const rows = SERVICE_ESCALATION_KINDS.map((kind) => {
    const rule = rules[kind] ?? DEFAULT_REMINDER_RULES[kind];
    const meta = REMINDER_SUBJECT_META[kind];
    if (!rule.enabled) return { label: meta.label, value: "Off" };
    const timing = rule.timings?.[0] ? parseTimingKey(rule.timings[0]) : null;
    const timingLabel = timing ? formatTiming(timing) : "—";
    return { label: meta.label, value: `${timingLabel} · ${audienceSummary(kind, rule.audience)}` };
  });

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Service settings"
      primaryAction={null}
      dataAttr="service-settings-modal"
    >
      <div className="space-y-4">
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={onEditCatalog}
          data-attr="service-settings-edit-catalog"
        >
          Edit service catalog
        </Button>
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted">Requests</p>
          {loading ? <p className="text-sm text-muted">Loading…</p> : <ConfirmRows rows={rows} />}
        </div>
      </div>
    </PortalDialog>
  );
}
