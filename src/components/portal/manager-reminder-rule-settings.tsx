"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_REMINDER_RULES,
  normalizeReminderSettings,
  type ReminderRule,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { timingKey } from "@/lib/reminders/timings";
import {
  fillReminderTemplate,
  reminderSubjectSettingsMeta,
  type ReminderAudienceMode,
} from "@/lib/reminders/subject-settings-meta";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  ReminderMessagePreviewCard,
  ReminderMessageUpdateModal,
  ReminderSendViaField,
  ReminderTimingMultiSelect,
  REMINDER_FIELD_LABEL_CLASS,
} from "@/components/portal/reminder-settings-shared";

export type ManagerReminderRuleSettingsHandle = {
  saveIfDirty: () => Promise<boolean>;
};

function ruleSnapshot(rule: ReminderRule): string {
  return JSON.stringify(rule);
}

function resolveTemplate(
  kind: ReminderSubjectKind,
  rule: ReminderRule,
): { subject: string; body: string } {
  const meta = reminderSubjectSettingsMeta(kind);
  const base = rule.template ?? meta?.defaultTemplate ?? { subject: "Reminder", body: "" };
  if (!meta) return base;
  return fillReminderTemplate(base, meta.previewContext);
}

export function ManagerReminderRuleSettingsPanel({
  kind,
  audienceMode,
  sectionTitle,
  teamMembers,
  formRef,
  disabled: disabledProp,
}: {
  kind: ReminderSubjectKind;
  audienceMode: ReminderAudienceMode;
  sectionTitle?: string;
  teamMembers: WorkAssignmentTeamMember[];
  formRef?: Ref<ManagerReminderRuleSettingsHandle>;
  disabled?: boolean;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const meta = reminderSubjectSettingsMeta(kind);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rule, setRule] = useState<ReminderRule>(DEFAULT_REMINDER_RULES[kind]);
  const savedRef = useRef(ruleSnapshot(DEFAULT_REMINDER_RULES[kind]));
  const [messageModalOpen, setMessageModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) {
            const next = DEFAULT_REMINDER_RULES[kind];
            setRule(next);
            savedRef.current = ruleSnapshot(next);
          }
          return;
        }
        const res = await fetch("/api/portal/reminder-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load reminder settings.");
        const settings = normalizeReminderSettings(body.settings);
        const next = settings.rules[kind];
        if (!cancelled) {
          setRule(next);
          savedRef.current = ruleSnapshot(next);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load reminder settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, kind, showToast]);

  const isDirty = useMemo(() => ruleSnapshot(rule) !== savedRef.current, [rule]);
  const disabled = disabledProp || loading || saving;
  const templatePreview = useMemo(() => resolveTemplate(kind, rule), [kind, rule]);

  const selectedTimings = useMemo(() => {
    if (rule.timings?.length) return rule.timings;
    return rule.leadMinutes.map((minutes) => timingKey({ direction: "before", minutes }));
  }, [rule.leadMinutes, rule.timings]);

  const patchRule = useCallback((patch: Partial<ReminderRule>) => {
    setRule((current) => ({ ...current, ...patch }));
  }, []);

  const save = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      if (!isDirty) return true;
      setSaving(true);
      try {
        if (demo) {
          savedRef.current = ruleSnapshot(rule);
          if (!options?.silent) showToast("Reminder settings saved (demo).");
          return true;
        }
        const res = await fetch("/api/portal/reminder-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, rule }),
        });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save reminder settings.");
        const settings = normalizeReminderSettings(body.settings);
        const next = settings.rules[kind];
        setRule(next);
        savedRef.current = ruleSnapshot(next);
        if (!options?.silent) showToast("Reminder settings saved.");
        return true;
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save reminder settings.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [demo, isDirty, kind, rule, showToast],
  );

  const saveIfDirty = useCallback(async (): Promise<boolean> => save({ silent: true }), [save]);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  const showManager = audienceMode === "manager" || audienceMode === "both";
  const showCounterparty = audienceMode === "counterparty" || audienceMode === "both";
  const showTeam = teamMembers.length > 1;

  if (!meta) {
    return <p className="text-sm text-muted">Reminder settings are not available for this subject yet.</p>;
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <>
      <div className="space-y-4">
        {sectionTitle ? <p className="text-[13.5px] font-semibold text-foreground">{sectionTitle}</p> : null}

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={rule.enabled}
            disabled={disabled}
            data-attr={`reminder-rule-${kind}-enabled`}
            onChange={(e) => patchRule({ enabled: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground">Send reminders</span>
            <span className="block text-xs text-muted">Automated nudges relative to {meta.timingLabel.toLowerCase()}.</span>
          </span>
        </label>

        {rule.enabled ? (
          <>
            <ReminderTimingMultiSelect
              timings={selectedTimings}
              directions={meta.directions}
              label={meta.timingLabel}
              disabled={disabled}
              dataAttr={`reminder-rule-${kind}-timings`}
              onChangeTimings={(timings) => patchRule({ timings })}
            />

            <div>
              <p className={REMINDER_FIELD_LABEL_CLASS}>Notify</p>
              <div className="mt-2 flex flex-wrap gap-4">
                {showManager ? (
                  <label className="flex items-center gap-2 text-[13px] text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={rule.audience.manager}
                      disabled={disabled}
                      data-attr={`reminder-rule-${kind}-notify-manager`}
                      onChange={(e) =>
                        patchRule({ audience: { ...rule.audience, manager: e.target.checked } })
                      }
                    />
                    {meta.notifyYouLabel}
                  </label>
                ) : null}
                {showTeam ? (
                  <label className="flex items-center gap-2 text-[13px] text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={rule.audience.team}
                      disabled={disabled}
                      data-attr={`reminder-rule-${kind}-notify-team`}
                      onChange={(e) =>
                        patchRule({ audience: { ...rule.audience, team: e.target.checked } })
                      }
                    />
                    {meta.notifyTeamLabel}
                  </label>
                ) : null}
                {showCounterparty ? (
                  <label className="flex items-center gap-2 text-[13px] text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={rule.audience.counterparty}
                      disabled={disabled}
                      data-attr={`reminder-rule-${kind}-notify-counterparty`}
                      onChange={(e) =>
                        patchRule({ audience: { ...rule.audience, counterparty: e.target.checked } })
                      }
                    />
                    {meta.notifyCounterpartyLabel}
                  </label>
                ) : null}
              </div>
            </div>

            {showTeam && rule.audience.team ? (
              <div>
                <p className={REMINDER_FIELD_LABEL_CLASS}>Team members</p>
                <div className="mt-2 flex flex-wrap gap-3">
                  {teamMembers.map((member) => {
                    const selected =
                      rule.teamUserIds.length === 0 || rule.teamUserIds.includes(member.userId);
                    return (
                      <label key={member.userId} className="flex items-center gap-2 text-[13px] text-foreground">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={selected}
                          disabled={disabled}
                          data-attr={`reminder-rule-${kind}-team-${member.userId}`}
                          onChange={(e) => {
                            const allIds = teamMembers.map((row) => row.userId);
                            const current =
                              rule.teamUserIds.length === 0 ? allIds : [...rule.teamUserIds];
                            const next = e.target.checked
                              ? [...new Set([...current, member.userId])]
                              : current.filter((id) => id !== member.userId);
                            patchRule({
                              teamUserIds:
                                next.length === allIds.length || next.length === 0 ? [] : next,
                            });
                          }}
                        />
                        {member.name?.trim() || member.email?.trim() || "Team member"}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <ReminderSendViaField
              showProplaneChannel
              viaInbox={rule.inbox}
              viaEmail={rule.email}
              viaSms={rule.sms}
              disabled={disabled}
              onChange={({ viaEmail, viaSms, viaInbox }) =>
                patchRule({
                  inbox: viaInbox !== false,
                  email: viaEmail,
                  sms: viaSms,
                })
              }
              dataAttr={`reminder-rule-${kind}-send-via`}
            />

            <ReminderMessagePreviewCard
              subject={templatePreview.subject}
              body={templatePreview.body}
              onUpdate={() => setMessageModalOpen(true)}
              dataAttr={`reminder-rule-${kind}-update-message`}
            />
          </>
        ) : null}
      </div>

      <ReminderMessageUpdateModal
        open={messageModalOpen}
        onClose={() => setMessageModalOpen(false)}
        subject={rule.template?.subject ?? meta.defaultTemplate.subject}
        body={rule.template?.body ?? meta.defaultTemplate.body}
        recipient={meta.recipientPreview}
        viaInbox={rule.inbox}
        viaEmail={rule.email}
        viaSms={rule.sms}
        placeholders={meta.placeholders}
        onSave={(next) => patchRule({ template: next })}
      />
    </>
  );
}
