"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  ManagerReminderRuleSettingsPanel,
  type ManagerReminderRuleSettingsHandle,
} from "@/components/portal/manager-reminder-rule-settings";
import type { SettingsSourceNamespace } from "@/components/portal/settings-property-scope";
import {
  PaymentAutomationSettingsPanel,
  type PaymentAutomationSettingsHandle,
} from "@/components/portal/payment-schedule-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  DEFAULT_REMINDER_SETTINGS,
  normalizeReminderSettings,
  type ReminderRule,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import type { ReminderAudienceMode } from "@/lib/reminders/subject-settings-meta";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import { ReminderTypePicker } from "@/components/portal/reminder-type-picker";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import {
  DEFAULT_SERVICE_AUTOMATION_SETTINGS,
  REOFFER_AFTER_VENDOR_SILENT_OPTIONS,
  normalizeServiceAutomationSettings,
  type ServiceAutomationSettings,
} from "@/lib/service-automation-settings";

function useBundledReminderSave(
  refs: Array<React.RefObject<ManagerReminderRuleSettingsHandle | null>>,
): ManagerReminderRuleSettingsHandle {
  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    for (const ref of refs) {
      const ok = await ref.current?.saveIfDirty();
      if (ok === false) return false;
    }
    return true;
  }, [refs]);

  return { saveIfDirty };
}

function HiddenReminderRulePanel({
  hidden,
  kind,
  audienceMode,
  teamMembers,
  formRef,
  disabled,
  sourceNamespace,
}: {
  hidden: boolean;
  kind: ReminderSubjectKind;
  audienceMode: ReminderAudienceMode;
  teamMembers: WorkAssignmentTeamMember[];
  formRef: React.RefObject<ManagerReminderRuleSettingsHandle | null>;
  disabled?: boolean;
  sourceNamespace?: SettingsSourceNamespace;
}) {
  return (
    <div className={hidden ? "hidden" : undefined} aria-hidden={hidden}>
      <ManagerReminderRuleSettingsPanel
        kind={kind}
        audienceMode={audienceMode}
        teamMembers={teamMembers}
        formRef={formRef}
        disabled={disabled}
        sourceNamespace={sourceNamespace}
      />
    </div>
  );
}

const APPLICATION_REMINDER_TYPES = [
  {
    value: "incomplete" as const,
    label: "Incomplete application",
  },
  {
    value: "manager" as const,
    label: "My application alerts",
  },
  {
    value: "post_tour" as const,
    label: "Post-tour apply link",
  },
];

export function ApplicationRemindersSettingsBundle({
  teamMembers,
  disabled,
  formRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  disabled?: boolean;
  formRef?: Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const [type, setType] = useState<"incomplete" | "manager" | "post_tour">("incomplete");
  const incompleteRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const managerRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const postTourRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const bundle = useBundledReminderSave([incompleteRef, managerRef, postTourRef]);

  useImperativeHandle(formRef, () => bundle, [bundle]);

  return (
    <div className="space-y-4">
      <ReminderTypePicker
        value={type}
        options={APPLICATION_REMINDER_TYPES}
        onChange={setType}
        disabled={disabled}
        dataAttr="application-reminder-type"
      />
      <HiddenReminderRulePanel
        hidden={type !== "incomplete"}
        kind="application"
        audienceMode="counterparty"
        teamMembers={teamMembers}
        formRef={incompleteRef}
        disabled={disabled}
      />
      <HiddenReminderRulePanel
        hidden={type !== "manager"}
        kind="application_manager"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={managerRef}
        disabled={disabled}
      />
      <HiddenReminderRulePanel
        hidden={type !== "post_tour"}
        kind="application_post_tour"
        audienceMode="counterparty"
        teamMembers={teamMembers}
        formRef={postTourRef}
        disabled={disabled}
      />
    </div>
  );
}

const LEASE_REMINDER_TYPES = [
  {
    value: "resident" as const,
    label: "Resident lease reminders",
  },
  {
    value: "manager" as const,
    label: "My lease alerts",
  },
];

export function LeaseRemindersSettingsBundle({
  teamMembers,
  disabled,
  formRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  disabled?: boolean;
  formRef?: Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const [type, setType] = useState<"resident" | "manager">("resident");
  const residentRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const managerRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const bundle = useBundledReminderSave([residentRef, managerRef]);

  useImperativeHandle(formRef, () => bundle, [bundle]);

  return (
    <div className="space-y-4">
      <ReminderTypePicker
        value={type}
        options={LEASE_REMINDER_TYPES}
        onChange={setType}
        disabled={disabled}
        dataAttr="lease-reminder-type"
      />
      <HiddenReminderRulePanel
        hidden={type !== "resident"}
        kind="lease"
        audienceMode="counterparty"
        teamMembers={teamMembers}
        formRef={residentRef}
        disabled={disabled}
      />
      <HiddenReminderRulePanel
        hidden={type !== "manager"}
        kind="lease_manager"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={managerRef}
        disabled={disabled}
      />
    </div>
  );
}

const SERVICE_REMINDER_TYPES = [
  {
    value: "service" as const,
    label: "Service reminder",
  },
];

const SERVICE_REPLY_TEMPLATES = [
  {
    value: "maintenance" as const,
    label: "Maintenance visit",
  },
  {
    value: "addon" as const,
    label: "Add-on service",
  },
];

const OUTGOING_PAYMENT_REMINDER_TYPES = [
  {
    value: "outgoing" as const,
    label: "Outgoing payment reminder",
  },
];

export function OutgoingPaymentRemindersSettingsBundle({
  teamMembers,
  disabled,
  formRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  disabled?: boolean;
  formRef?: Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const [type, setType] = useState<"outgoing">("outgoing");
  const outgoingRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const bundle = useBundledReminderSave([outgoingRef]);

  useImperativeHandle(formRef, () => bundle, [bundle]);

  return (
    <div className="space-y-4">
      <ReminderTypePicker
        value={type}
        options={OUTGOING_PAYMENT_REMINDER_TYPES}
        onChange={setType}
        disabled={disabled}
        dataAttr="outgoing-payment-reminder-type"
      />
      <HiddenReminderRulePanel
        hidden={type !== "outgoing"}
        kind="outgoing_payment"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={outgoingRef}
        disabled={disabled}
        sourceNamespace="outgoing-payment-reminders"
      />
    </div>
  );
}

const INCOMING_PAYMENT_REMINDER_TYPES = [
  {
    value: "resident" as const,
    label: "Resident notification",
  },
  {
    value: "manager" as const,
    label: "Manager notification",
  },
];

function ResidentPaymentReminderSettingsPanel({
  onSaved,
  formRef,
  hidden,
}: {
  onSaved?: () => void;
  formRef?: Ref<PaymentAutomationSettingsHandle>;
  hidden: boolean;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ManagerAutomationSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setSettings(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
          return;
        }
        const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load payment settings.");
        const body = (await res.json()) as { settings: ManagerAutomationSettings };
        if (!cancelled) setSettings(normalizeManagerAutomationSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load payment settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  return (
    <div className={hidden ? "hidden" : undefined} aria-hidden={hidden}>
      {loading || !settings ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <PaymentAutomationSettingsPanel
          settings={settings}
          variant="payments"
          layout="modal"
          autoSaveOnClose
          embeddedInBundle
          formRef={formRef}
          onSaved={(next) => {
            setSettings(next);
            onSaved?.();
          }}
        />
      )}
    </div>
  );
}

export function IncomingPaymentRemindersSettingsBundle({
  teamMembers,
  disabled,
  onSaved,
  formRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  disabled?: boolean;
  onSaved?: () => void;
  formRef?: Ref<PaymentAutomationSettingsHandle>;
}) {
  const [type, setType] = useState<"resident" | "manager">("resident");
  const residentRef = useRef<PaymentAutomationSettingsHandle | null>(null);
  const managerRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    const residentOk = await residentRef.current?.saveIfDirty();
    if (residentOk === false) return false;
    const managerOk = await managerRef.current?.saveIfDirty();
    if (managerOk === false) return false;
    return true;
  }, []);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  return (
    <div className="space-y-4">
      <p className="text-[13.5px] font-semibold text-foreground">Payment reminders</p>
      <ReminderTypePicker
        value={type}
        options={INCOMING_PAYMENT_REMINDER_TYPES}
        onChange={setType}
        disabled={disabled}
        dataAttr="incoming-payment-reminder-type"
      />
      <ResidentPaymentReminderSettingsPanel
        hidden={type !== "resident"}
        formRef={residentRef}
        onSaved={onSaved}
      />
      <HiddenReminderRulePanel
        hidden={type !== "manager"}
        kind="payment_manager"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={managerRef}
        disabled={disabled}
        sourceNamespace="incoming-payment-reminders"
      />
    </div>
  );
}

export function ServiceRemindersSettingsBundle({
  teamMembers,
  workOrderFormRef,
  serviceOrderFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  workOrderFormRef?: Ref<ManagerReminderRuleSettingsHandle>;
  serviceOrderFormRef?: Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const [type, setType] = useState<"service">("service");
  const [template, setTemplate] = useState<"maintenance" | "addon">("maintenance");
  const maintenanceRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const addonRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const maintenanceBundle = useBundledReminderSave([maintenanceRef]);
  const addonBundle = useBundledReminderSave([addonRef]);

  useImperativeHandle(workOrderFormRef, () => maintenanceBundle, [maintenanceBundle]);
  useImperativeHandle(serviceOrderFormRef, () => addonBundle, [addonBundle]);

  return (
    <div className="space-y-4">
      <ReminderTypePicker
        value={type}
        options={SERVICE_REMINDER_TYPES}
        onChange={setType}
        dataAttr="service-reminder-type"
      />
      <ReminderTypePicker
        label="Template"
        value={template}
        options={SERVICE_REPLY_TEMPLATES}
        onChange={setTemplate}
        dataAttr="service-reminder-template"
      />
      <HiddenReminderRulePanel
        hidden={template !== "maintenance"}
        kind="work_order"
        audienceMode="both"
        teamMembers={teamMembers}
        formRef={maintenanceRef}
      />
      <HiddenReminderRulePanel
        hidden={template !== "addon"}
        kind="service_order"
        audienceMode="both"
        teamMembers={teamMembers}
        formRef={addonRef}
      />
    </div>
  );
}

const INSPECTION_REMINDER_TYPES = [
  {
    value: "due" as const,
    label: "Move-in & move-out inspections",
  },
  {
    value: "review" as const,
    label: "My review alerts",
  },
];

/**
 * Inspection reminders.
 *
 * The due reminder is deliberately BOTH-audience: a condition report is somebody's job on the
 * day, and reminding only the resident means nobody in the office learns it was missed. The
 * review alert is manager-side only — there is nothing for a resident to review.
 */
export function InspectionRemindersSettingsBundle({
  teamMembers,
  dueFormRef,
  reviewFormRef,
}: {
  teamMembers: WorkAssignmentTeamMember[];
  dueFormRef?: Ref<ManagerReminderRuleSettingsHandle>;
  reviewFormRef?: Ref<ManagerReminderRuleSettingsHandle>;
}) {
  const [type, setType] = useState<"due" | "review">("due");
  const dueRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const reviewRef = useRef<ManagerReminderRuleSettingsHandle | null>(null);
  const dueBundle = useBundledReminderSave([dueRef]);
  const reviewBundle = useBundledReminderSave([reviewRef]);

  useImperativeHandle(dueFormRef, () => dueBundle, [dueBundle]);
  useImperativeHandle(reviewFormRef, () => reviewBundle, [reviewBundle]);

  return (
    <div className="space-y-4">
      <ReminderTypePicker
        value={type}
        options={INSPECTION_REMINDER_TYPES}
        onChange={setType}
        dataAttr="inspection-reminder-type"
      />
      <HiddenReminderRulePanel
        hidden={type !== "due"}
        kind="inspection"
        audienceMode="both"
        teamMembers={teamMembers}
        formRef={dueRef}
      />
      <HiddenReminderRulePanel
        hidden={type !== "review"}
        kind="inspection_manager"
        audienceMode="manager"
        teamMembers={teamMembers}
        formRef={reviewRef}
      />
    </div>
  );
}

/**
 * Compact settings rows for the PLAN-0915 area 4 escalation and lease-ending
 * moments — one row per kind (label + two `FieldSingleSelect`s: when, and
 * who/what), never the full timing-multi-select + template panel the other
 * bundles above use. These kinds are deliberately single-timing
 * (`COMPACT_RULE_KINDS`) so one offset is the whole control.
 *
 * Reads/writes the SAME two settings sources every other row on Services and
 * Leases already reads — `/api/portal/reminder-settings` (per-kind PATCH) and,
 * for the one action escalation, `/api/portal/service-automation-settings` —
 * scoped by the module's own scope bar (`useSettingsPropertyScope`), exactly
 * like `ManagerReminderRuleSettingsPanel` and `PaymentAutomationSettingsPanel`
 * above.
 */
function scopeSearchParams(scope: { propertyId: string; workspaceId: string }): string {
  const params = new URLSearchParams();
  if (scope.propertyId) params.set("propertyId", scope.propertyId);
  else if (scope.workspaceId) params.set("workspaceId", scope.workspaceId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** One label + up to two `FieldSingleSelect`s, matching every other settings row's shape (no subtext). */
function CompactAutomationRow({
  label,
  primary,
  secondary,
  disabled,
}: {
  label: string;
  primary: { value: string; options: { value: string; label: string }[]; onChange: (next: string) => void; dataAttr: string };
  secondary?: { value: string; options: { value: string; label: string }[]; onChange: (next: string) => void; dataAttr: string };
  disabled?: boolean;
}) {
  return (
    <PortalSettingsRow label={label}>
      <div className="flex items-center gap-2">
        <FieldSingleSelect
          label={label}
          hideLabel
          value={primary.value}
          options={primary.options}
          onChange={primary.onChange}
          disabled={disabled}
          dataAttr={primary.dataAttr}
          wrapperClassName="w-[136px]"
        />
        {secondary ? (
          <FieldSingleSelect
            label={label}
            hideLabel
            value={secondary.value}
            options={secondary.options}
            onChange={secondary.onChange}
            disabled={disabled}
            dataAttr={secondary.dataAttr}
            wrapperClassName="w-[168px]"
          />
        ) : null}
      </div>
    </PortalSettingsRow>
  );
}

const ESCALATION_LEAD_OPTIONS = [
  { value: "after:60", label: "1 hour" },
  { value: "after:240", label: "4 hours" },
  { value: "after:1440", label: "1 day" },
  { value: "after:2880", label: "2 days" },
];

const ESCALATION_AUDIENCE_OPTIONS = [
  { value: "manager", label: "Notify you" },
  { value: "manager_team", label: "You + co-managers" },
];

function audienceSelectValue(audience: ReminderRule["audience"]): string {
  return audience.team ? "manager_team" : "manager";
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Escalation (Services). "Unassigned request" and "Emergency unassigned" are
 * timed reminder rules; "Vendor silent after accept" is an ACTION (a
 * re-offer), so its offset and on/off live in `serviceAutomation` beside
 * `requireOnMyWay` — same resolver, same scope, different namespace.
 */
export function ServiceEscalationSettingsBundle({ disabled }: { disabled?: boolean }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const scope = useSettingsPropertyScope();
  const qs = scopeSearchParams(scope);
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [service, setService] = useState<ServiceAutomationSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      scope.reportLoading("service-escalations", true);
      if (demo) {
        if (!cancelled) {
          setReminders(DEFAULT_REMINDER_SETTINGS);
          setService(DEFAULT_SERVICE_AUTOMATION_SETTINGS);
        }
      } else {
        const [remindersBody, serviceBody] = await Promise.all([
          fetchJson<{ settings: ReminderSettings }>(`/api/portal/reminder-settings${qs}`),
          fetchJson<{ settings: ServiceAutomationSettings }>(`/api/portal/service-automation-settings${qs}`),
        ]);
        if (!cancelled) {
          setReminders(remindersBody ? normalizeReminderSettings(remindersBody.settings) : DEFAULT_REMINDER_SETTINGS);
          setService(serviceBody ? normalizeServiceAutomationSettings(serviceBody.settings) : DEFAULT_SERVICE_AUTOMATION_SETTINGS);
        }
      }
      if (!cancelled) {
        setLoading(false);
        scope.reportLoading("service-escalations", false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, qs]);

  const patchRule = useCallback(
    async (kind: "work_order_unassigned" | "work_order_unassigned_emergency", patch: Partial<ReminderRule>) => {
      setReminders((prev) =>
        prev ? { ...prev, rules: { ...prev.rules, [kind]: { ...prev.rules[kind], ...patch } } } : prev,
      );
      if (demo) return;
      try {
        const res = await fetch(`/api/portal/reminder-settings${qs}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, rule: patch }),
        });
        if (!res.ok) throw new Error("Could not save the escalation setting.");
        const body = (await res.json()) as { settings: ReminderSettings };
        setReminders(normalizeReminderSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the escalation setting.");
      }
    },
    [demo, qs, showToast],
  );

  const patchReoffer = useCallback(
    async (hours: 0 | 24 | 48) => {
      setService((prev) => (prev ? { ...prev, reofferAfterVendorSilentHours: hours } : prev));
      if (demo) return;
      try {
        const res = await fetch(`/api/portal/service-automation-settings${qs}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reofferAfterVendorSilentHours: hours }),
        });
        if (!res.ok) throw new Error("Could not save the escalation setting.");
        const body = (await res.json()) as { settings: ServiceAutomationSettings };
        setService(normalizeServiceAutomationSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the escalation setting.");
      }
    },
    [demo, qs, showToast],
  );

  if (loading || !reminders || !service) return <p className="text-sm text-muted">Loading…</p>;
  const unassigned = reminders.rules.work_order_unassigned;
  const emergency = reminders.rules.work_order_unassigned_emergency;

  return (
    <PortalSettingsGroup>
      <CompactAutomationRow
        label="Unassigned request"
        primary={{
          value: unassigned.timings?.[0] ?? "after:1440",
          options: ESCALATION_LEAD_OPTIONS,
          onChange: (next) => patchRule("work_order_unassigned", { timings: [next] }),
          dataAttr: "escalation-unassigned-lead",
        }}
        secondary={{
          value: audienceSelectValue(unassigned.audience),
          options: ESCALATION_AUDIENCE_OPTIONS,
          onChange: (next) =>
            patchRule("work_order_unassigned", { audience: { ...unassigned.audience, team: next === "manager_team" } }),
          dataAttr: "escalation-unassigned-audience",
        }}
        disabled={disabled}
      />
      <CompactAutomationRow
        label="Emergency unassigned"
        primary={{
          value: emergency.timings?.[0] ?? "after:60",
          options: ESCALATION_LEAD_OPTIONS,
          onChange: (next) => patchRule("work_order_unassigned_emergency", { timings: [next] }),
          dataAttr: "escalation-emergency-lead",
        }}
        secondary={{
          value: audienceSelectValue(emergency.audience),
          options: ESCALATION_AUDIENCE_OPTIONS,
          onChange: (next) =>
            patchRule("work_order_unassigned_emergency", { audience: { ...emergency.audience, team: next === "manager_team" } }),
          dataAttr: "escalation-emergency-audience",
        }}
        disabled={disabled}
      />
      <CompactAutomationRow
        label="Vendor silent after accept"
        primary={{
          value: String(service.reofferAfterVendorSilentHours),
          options: REOFFER_AFTER_VENDOR_SILENT_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
          onChange: (next) => patchReoffer(Number(next) as 0 | 24 | 48),
          dataAttr: "escalation-vendor-silent-hours",
        }}
        secondary={{
          value: "reoffer",
          options: [{ value: "reoffer", label: "Re-offer to next vendor" }],
          onChange: () => undefined,
          dataAttr: "escalation-vendor-silent-action",
        }}
        disabled={disabled}
      />
    </PortalSettingsGroup>
  );
}

const LEASE_ENDING_LEAD_OPTIONS = [
  { value: "before:1440", label: "1 day" },
  { value: "before:10080", label: "7 days" },
  { value: "before:20160", label: "14 days" },
  { value: "before:43200", label: "30 days" },
  { value: "before:86400", label: "60 days" },
  { value: "before:129600", label: "90 days" },
];

const DEPOSIT_RETURN_LEAD_OPTIONS = [{ value: "before:5", label: "Day of move-out" }];

const CHANNEL_OPTIONS = [
  { value: "email", label: "Email" },
  { value: "email_sms", label: "Email + SMS" },
];

function channelSelectValue(rule: ReminderRule): string {
  return rule.sms ? "email_sms" : "email";
}

/** Lease-ending sequence (Leases): renewal offer, move-out instructions, deposit return notice. Informational only. */
export function LeaseEndingSettingsBundle({ disabled }: { disabled?: boolean }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const scope = useSettingsPropertyScope();
  const qs = scopeSearchParams(scope);
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      scope.reportLoading("lease-ending-sequence", true);
      if (demo) {
        if (!cancelled) setReminders(DEFAULT_REMINDER_SETTINGS);
      } else {
        const body = await fetchJson<{ settings: ReminderSettings }>(`/api/portal/reminder-settings${qs}`);
        if (!cancelled) setReminders(body ? normalizeReminderSettings(body.settings) : DEFAULT_REMINDER_SETTINGS);
      }
      if (!cancelled) {
        setLoading(false);
        scope.reportLoading("lease-ending-sequence", false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, qs]);

  const patchRule = useCallback(
    async (
      kind: "lease_renewal_offer" | "move_out_instructions" | "deposit_return_notice",
      patch: Partial<ReminderRule>,
    ) => {
      setReminders((prev) =>
        prev ? { ...prev, rules: { ...prev.rules, [kind]: { ...prev.rules[kind], ...patch } } } : prev,
      );
      if (demo) return;
      try {
        const res = await fetch(`/api/portal/reminder-settings${qs}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, rule: patch }),
        });
        if (!res.ok) throw new Error("Could not save the lease-ending setting.");
        const body = (await res.json()) as { settings: ReminderSettings };
        setReminders(normalizeReminderSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the lease-ending setting.");
      }
    },
    [demo, qs, showToast],
  );

  if (loading || !reminders) return <p className="text-sm text-muted">Loading…</p>;
  const renewal = reminders.rules.lease_renewal_offer;
  const instructions = reminders.rules.move_out_instructions;
  const deposit = reminders.rules.deposit_return_notice;

  return (
    <PortalSettingsGroup>
      <CompactAutomationRow
        label="Renewal offer"
        primary={{
          value: renewal.timings?.[0] ?? "before:86400",
          options: LEASE_ENDING_LEAD_OPTIONS,
          onChange: (next) => patchRule("lease_renewal_offer", { timings: [next] }),
          dataAttr: "lease-ending-renewal-lead",
        }}
        secondary={{
          value: channelSelectValue(renewal),
          options: CHANNEL_OPTIONS,
          onChange: (next) => patchRule("lease_renewal_offer", { sms: next === "email_sms" }),
          dataAttr: "lease-ending-renewal-channel",
        }}
        disabled={disabled}
      />
      <CompactAutomationRow
        label="Move-out instructions"
        primary={{
          value: instructions.timings?.[0] ?? "before:20160",
          options: LEASE_ENDING_LEAD_OPTIONS,
          onChange: (next) => patchRule("move_out_instructions", { timings: [next] }),
          dataAttr: "lease-ending-instructions-lead",
        }}
        secondary={{
          value: channelSelectValue(instructions),
          options: CHANNEL_OPTIONS,
          onChange: (next) => patchRule("move_out_instructions", { sms: next === "email_sms" }),
          dataAttr: "lease-ending-instructions-channel",
        }}
        disabled={disabled}
      />
      <CompactAutomationRow
        label="Deposit return notice"
        primary={{
          value: "before:5",
          options: DEPOSIT_RETURN_LEAD_OPTIONS,
          onChange: () => undefined,
          dataAttr: "lease-ending-deposit-lead",
        }}
        secondary={{
          value: channelSelectValue(deposit),
          options: CHANNEL_OPTIONS,
          onChange: (next) => patchRule("deposit_return_notice", { sms: next === "email_sms" }),
          dataAttr: "lease-ending-deposit-channel",
        }}
        disabled={disabled}
      />
    </PortalSettingsGroup>
  );
}
