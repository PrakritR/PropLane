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
import { fixedRuleFields, isRuleFieldFixed } from "@/lib/reminders/fixed-rule-fields";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  ReminderMessagePreviewCard,
  ReminderMessageUpdateModal,
  ReminderTimingMultiSelect,
  REMINDER_FIELD_LABEL_CLASS,
} from "@/components/portal/reminder-settings-shared";
import {
  PortalSettingsGroup,
  PortalSettingsLockedRow,
  PortalSettingsRow,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { cn } from "@/lib/utils";

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

/**
 * One compact pill in the inline channel cluster on an audience row. Inbox is
 * rendered permanently active and non-interactive — it is the durable record
 * (`ReminderRule.inbox` docs in `rules.ts`) and this control is the one place
 * that guarantee is enforced in the UI, so it can never be switched off here
 * regardless of what a caller passes for `active`.
 */
function ReminderChannelCell({
  active,
  label,
  locked,
  disabled,
  onToggle,
  dataAttr,
}: {
  active: boolean;
  label: string;
  locked?: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  dataAttr: string;
}) {
  const inert = locked || !onToggle;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={label}
      disabled={disabled || inert}
      data-attr={dataAttr}
      onClick={onToggle}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[-0.01em] transition-colors",
        active ? "border-primary/25 bg-primary/10 text-primary" : "border-border bg-card text-muted",
        disabled || inert ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-primary/30",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Inbox / Email / Text as compact inline cells, meant to sit directly on an
 * audience row instead of a separate "Send via" block underneath. All three
 * channels are rule-wide (one `inbox`/`email`/`sms` triple on `ReminderRule`,
 * not one per audience — see `rules.ts`), so every row that renders this
 * reads and writes the SAME state; that is intentional; there is no
 * per-audience channel to invent one for.
 */
function ReminderAudienceChannelCells({
  rule,
  disabled,
  dataAttr,
  onChange,
}: {
  rule: ReminderRule;
  disabled?: boolean;
  dataAttr: string;
  onChange: (next: { email: boolean; sms: boolean }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Delivery channels">
      <ReminderChannelCell active label="Inbox" locked disabled={disabled} dataAttr={`${dataAttr}-inbox`} />
      <ReminderChannelCell
        active={rule.email}
        label="Email"
        disabled={disabled}
        onToggle={() => onChange({ email: !rule.email, sms: rule.sms })}
        dataAttr={`${dataAttr}-email`}
      />
      <ReminderChannelCell
        active={rule.sms}
        label="Text"
        disabled={disabled}
        onToggle={() => onChange({ email: rule.email, sms: !rule.sms })}
        dataAttr={`${dataAttr}-sms`}
      />
    </div>
  );
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
  // The saved snapshot decides isDirty, which drives the UI — so it is render
  // state, not a ref. As a ref it was read during render (a lint error), and
  // isDirty's useMemo listed only `rule`, so it went stale after a save.
  const [savedSnapshot, setSavedSnapshot] = useState(ruleSnapshot(DEFAULT_REMINDER_RULES[kind]));
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
            setSavedSnapshot(ruleSnapshot(next));
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
          setSavedSnapshot(ruleSnapshot(next));
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

  const isDirty = useMemo(() => ruleSnapshot(rule) !== savedSnapshot, [rule, savedSnapshot]);
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
          setSavedSnapshot(ruleSnapshot(rule));
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
        setSavedSnapshot(ruleSnapshot(next));
        if (!options?.silent) showToast("Reminder settings saved.");
        return true;
      } catch (e) {
        // Unconditional — silent only suppresses the SUCCESS toast, never the
        // failure one. A per-control autosave that fails must still surface.
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

  /**
   * Per-control autosave: every row's `onChange` already updates `rule`
   * directly (`patchRule`), and this effect turns that into a save shortly
   * after — no Save button. Debounced so a burst of edits (e.g. toggling two
   * channel cells back to back) collapses into one PATCH rather than one per
   * click. `saveIfDirty` (above) still exists and is still what
   * `SettingsModulePage`'s flush-before-close calls — that contract is
   * unchanged; this effect is a second, earlier caller of the same `save`.
   */
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loading || !isDirty) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [isDirty, loading, save]);

  const showTeamOption = teamMembers.length > 1;

  if (!meta) {
    return <p className="text-sm text-muted">Reminder settings are not available for this subject yet.</p>;
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  const fixed = fixedRuleFields(kind);
  const timingsFixed = isRuleFieldFixed(kind, "timings");
  const audienceFixed = isRuleFieldFixed(kind, "audience");
  const channelsFixed = isRuleFieldFixed(kind, "channels");

  const showManagerAudience = audienceMode === "manager" || audienceMode === "both";
  const showCounterpartyAudience = audienceMode === "counterparty" || audienceMode === "both";

  const managerLockedReason = `This reminder doesn't notify you — it's meant for the ${meta.notifyCounterpartyLabel.toLowerCase()} only.`;
  const counterpartyLockedReason = `This reminder stays internal — the ${meta.notifyCounterpartyLabel.toLowerCase()} is never notified for it.`;
  const teamLockedReason = "Add co-managers under Team settings to notify them here.";

  const channelDataAttr = `reminder-rule-${kind}-channels`;
  const onChannelChange = ({ email, sms }: { email: boolean; sms: boolean }) =>
    // `inbox: true` — the durable record cannot be switched off from this panel;
    // see `ReminderAudienceChannelCells` / `ReminderChannelCell` above.
    patchRule({ inbox: true, email, sms });

  return (
    <>
      <div className="space-y-4">
        {sectionTitle ? <p className="text-[13.5px] font-semibold text-foreground">{sectionTitle}</p> : null}

        <PortalSettingsGroup>
          <PortalSettingsRow
            label="Send reminders"
            meta="Turns this reminder on or off. Every setting below is ignored while it's off."
          >
            <PortalSettingsToggle
              checked={rule.enabled}
              onChange={(next) => patchRule({ enabled: next })}
              label="Send reminders"
              disabled={disabled}
              dataAttr={`reminder-rule-${kind}-enabled`}
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>

        {rule.enabled ? (
          <>
            {timingsFixed && fixed ? (
              <PortalSettingsGroup>
                <PortalSettingsLockedRow label={meta.timingLabel} reason={fixed.reason} />
              </PortalSettingsGroup>
            ) : (
              <ReminderTimingMultiSelect
                timings={selectedTimings}
                directions={meta.directions}
                label={meta.timingLabel}
                disabled={disabled}
                dataAttr={`reminder-rule-${kind}-timings`}
                onChangeTimings={(timings) => patchRule({ timings })}
              />
            )}

            <div>
              <p className={REMINDER_FIELD_LABEL_CLASS}>Notify</p>
              <PortalSettingsGroup className="mt-2">
                {audienceFixed && fixed ? (
                  <PortalSettingsLockedRow label="Who's notified" reason={fixed.reason} />
                ) : (
                  <>
                    {showManagerAudience ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyYouLabel}
                        meta="Notifies you through the channels selected here."
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <PortalSettingsToggle
                            checked={rule.audience.manager}
                            onChange={(next) => patchRule({ audience: { ...rule.audience, manager: next } })}
                            label={`Notify ${meta.notifyYouLabel}`}
                            disabled={disabled}
                            dataAttr={`reminder-rule-${kind}-notify-manager`}
                          />
                          {!channelsFixed ? (
                            <ReminderAudienceChannelCells
                              rule={rule}
                              disabled={disabled}
                              dataAttr={channelDataAttr}
                              onChange={onChannelChange}
                            />
                          ) : null}
                        </div>
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyYouLabel} reason={managerLockedReason} />
                    )}

                    {showTeamOption ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyTeamLabel}
                        meta="Notifies your team through the channels selected here."
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <PortalSettingsToggle
                            checked={rule.audience.team}
                            onChange={(next) => patchRule({ audience: { ...rule.audience, team: next } })}
                            label={`Notify ${meta.notifyTeamLabel}`}
                            disabled={disabled}
                            dataAttr={`reminder-rule-${kind}-notify-team`}
                          />
                          {!channelsFixed ? (
                            <ReminderAudienceChannelCells
                              rule={rule}
                              disabled={disabled}
                              dataAttr={channelDataAttr}
                              onChange={onChannelChange}
                            />
                          ) : null}
                        </div>
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyTeamLabel} reason={teamLockedReason} />
                    )}

                    {showCounterpartyAudience ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyCounterpartyLabel}
                        meta={`Notifies the ${meta.notifyCounterpartyLabel.toLowerCase()} through the channels selected here.`}
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <PortalSettingsToggle
                            checked={rule.audience.counterparty}
                            onChange={(next) => patchRule({ audience: { ...rule.audience, counterparty: next } })}
                            label={`Notify ${meta.notifyCounterpartyLabel}`}
                            disabled={disabled}
                            dataAttr={`reminder-rule-${kind}-notify-counterparty`}
                          />
                          {!channelsFixed ? (
                            <ReminderAudienceChannelCells
                              rule={rule}
                              disabled={disabled}
                              dataAttr={channelDataAttr}
                              onChange={onChannelChange}
                            />
                          ) : null}
                        </div>
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyCounterpartyLabel} reason={counterpartyLockedReason} />
                    )}
                  </>
                )}
              </PortalSettingsGroup>

              {channelsFixed && fixed ? (
                <PortalSettingsGroup className="mt-2">
                  <PortalSettingsLockedRow label="Delivery channel" reason={fixed.reason} />
                </PortalSettingsGroup>
              ) : null}

              {!audienceFixed && showTeamOption && rule.audience.team ? (
                <div className="mt-3">
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
            </div>

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
        onSave={({ subject, body, viaInbox, viaEmail, viaSms }) =>
          patchRule({
            template: { subject, body },
            inbox: viaInbox,
            email: viaEmail,
            sms: viaSms,
          })
        }
      />
    </>
  );
}
