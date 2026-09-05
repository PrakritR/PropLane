"use client";

import { useCallback, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  ManagerReminderRuleSettingsPanel,
  type ManagerReminderRuleSettingsHandle,
} from "@/components/portal/manager-reminder-rule-settings";
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
