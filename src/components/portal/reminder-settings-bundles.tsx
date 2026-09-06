"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  ManagerReminderRuleSettingsPanel,
  type ManagerReminderRuleSettingsHandle,
} from "@/components/portal/manager-reminder-rule-settings";
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
import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import type { ReminderAudienceMode } from "@/lib/reminders/subject-settings-meta";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import { ReminderTypePicker } from "@/components/portal/reminder-type-picker";

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
}: {
  hidden: boolean;
  kind: ReminderSubjectKind;
  audienceMode: ReminderAudienceMode;
  teamMembers: WorkAssignmentTeamMember[];
  formRef: React.RefObject<ManagerReminderRuleSettingsHandle | null>;
  disabled?: boolean;
}) {
  return (
    <div className={hidden ? "hidden" : undefined} aria-hidden={hidden}>
      <ManagerReminderRuleSettingsPanel
        kind={kind}
        audienceMode={audienceMode}
        teamMembers={teamMembers}
        formRef={formRef}
        disabled={disabled}
      />
    </div>
  );
}

const APPLICATION_REMINDER_TYPES = [
  {
    value: "incomplete" as const,
    label: "Incomplete application",
    description: "Nudge applicants who started but have not submitted their application.",
  },
  {
    value: "manager" as const,
    label: "My application alerts",
    description: "Notify you when an application sits incomplete too long.",
  },
  {
    value: "post_tour" as const,
    label: "Post-tour apply link",
    description: "After a tour, send prospects the application link and next steps.",
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
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-[13.5px] font-semibold text-foreground">Application reminders</p>
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
    description: "Nudge residents to sign a lease you sent for signature.",
  },
  {
    value: "manager" as const,
    label: "My lease alerts",
    description: "Notify you when a lease needs review or a resident has not signed.",
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
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-[13.5px] font-semibold text-foreground">Lease reminders</p>
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
    value: "maintenance" as const,
    label: "Maintenance visit reminders",
    description: "Before a maintenance visit at a property.",
  },
  {
    value: "addon" as const,
    label: "Add-on service reminders",
    description: "Before a resident add-on service visit.",
  },
];

const OUTGOING_PAYMENT_REMINDER_TYPES = [
  {
    value: "outgoing" as const,
    label: "Outgoing payment reminder",
    description: "Nudge you before bills you owe are due — never sent to payees.",
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
      <p className="text-[13.5px] font-semibold text-foreground">Outgoing payment reminders</p>
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
      />
    </div>
  );
}

const INCOMING_PAYMENT_REMINDER_TYPES = [
  {
    value: "resident" as const,
    label: "Resident notification for payment",
    description: "Remind residents before rent is due, on the due date, and when overdue.",
  },
  {
    value: "manager" as const,
    label: "Manager notification for payment",
    description: "Alert you when rent is still unpaid after the due date.",
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
  const [type, setType] = useState<"maintenance" | "addon">("maintenance");
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
      <HiddenReminderRulePanel
        hidden={type !== "maintenance"}
        kind="work_order"
        audienceMode="both"
        teamMembers={teamMembers}
        formRef={maintenanceRef}
      />
      <HiddenReminderRulePanel
        hidden={type !== "addon"}
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
    description: "Remind around the move date that a condition report is due. One control covers both moves.",
  },
  {
    value: "review" as const,
    label: "My review alerts",
    description: "Notify you when a report has evidence waiting for your review.",
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
