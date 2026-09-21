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
  VENDOR_AUDIENCE_KINDS,
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
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import {
  PortalSettingsGroup,
  PortalSettingsLockedRow,
  PortalSettingsRow,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
  type SettingsSourceNamespace,
} from "@/components/portal/settings-property-scope";

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
 * Inbox / Email / Text as ONE multi-select for the whole rule. All three
 * channels are rule-wide (one `inbox`/`email`/`sms` triple on `ReminderRule`,
 * not one per audience — see `rules.ts`), so this is rendered exactly ONCE per
 * rule, in its own "Send via" row below the audience list, never inside an
 * individual audience row. Drawing it per audience row previously told the
 * manager the channels were independent per audience when they are actually
 * one shared value. Do not reintroduce a per-audience instance.
 *
 * Inbox is always ticked and cannot be unticked — it is the durable record
 * (`ReminderRule.inbox` docs in `rules.ts`) and this control is the one place
 * that guarantee is enforced in the UI.
 */
function ReminderRuleSendViaSelect({
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
  const selected = ["inbox", ...(rule.email ? ["email"] : []), ...(rule.sms ? ["sms"] : [])];
  return (
    <CheckboxMultiSelect
      label="Send via"
      hideLabel
      options={[
        { value: "inbox", label: "Inbox", disabled: true },
        { value: "email", label: "Email" },
        { value: "sms", label: "Text" },
      ]}
      selected={selected}
      onChange={(next) => onChange({ email: next.includes("email"), sms: next.includes("sms") })}
      disabled={disabled}
      dataAttr={dataAttr}
      className="w-48"
    />
  );
}

export function ManagerReminderRuleSettingsPanel({
  kind,
  audienceMode,
  sectionTitle,
  teamMembers,
  formRef,
  disabled: disabledProp,
  sourceNamespace = "reminder-settings",
}: {
  kind: ReminderSubjectKind;
  audienceMode: ReminderAudienceMode;
  sectionTitle?: string;
  teamMembers: WorkAssignmentTeamMember[];
  formRef?: Ref<ManagerReminderRuleSettingsHandle>;
  disabled?: boolean;
  /**
   * Which scope-tag key this instance reports to. Defaults to the shared
   * "reminder-settings" key every reminder screen used before phase E — safe
   * as long as only one reminder panel using that key is mounted at a time.
   * Payments now stacks Incoming and Outgoing reminders simultaneously, so
   * those two callers pass distinct keys instead of racing to overwrite the
   * same one (`settings-property-scope.tsx`).
   */
  sourceNamespace?: SettingsSourceNamespace;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  // Workspace + per-property scope (PLAN-0916-1040 / PLAN-0920-0845 phase D).
  // Outside an Operations pane the provider is absent and this is the no-op
  // account scope, so a reminder editor in the per-tab gear modal keeps its
  // original workspace-only behaviour.
  const {
    propertyId: scopePropertyId,
    propertyIds: scopePropertyIds,
    workspaceId: scopeWorkspaceId,
    reportOverriddenPropertyIds,
    reportSource,
    reportLoading: reportScopeLoading,
    resetSignal,
  } = useSettingsPropertyScope();
  const scopeKey = `reminder:${kind}`;
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
      reportScopeLoading(scopeKey, true);
      try {
        if (demo) {
          if (!cancelled) {
            const next = DEFAULT_REMINDER_RULES[kind];
            setRule(next);
            setSavedSnapshot(ruleSnapshot(next));
          }
          return;
        }
        // `?propertyId=&workspaceId=` scopes the read; both "" reads the account.
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/reminder-settings${query}`, { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: unknown;
          error?: string;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not load reminder settings.");
        const settings = normalizeReminderSettings(body.settings);
        const next = settings.rules[kind];
        if (!cancelled) {
          setRule(next);
          setSavedSnapshot(ruleSnapshot(next));
          reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
          reportSource(sourceNamespace, body.source);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load reminder settings.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          reportScopeLoading(scopeKey, false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    demo,
    kind,
    showToast,
    scopePropertyId,
    scopeWorkspaceId,
    scopeKey,
    sourceNamespace,
    reportOverriddenPropertyIds,
    reportSource,
    reportScopeLoading,
  ]);

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
      reportSaveStatus({ type: "start" });
      try {
        if (demo) {
          setSavedSnapshot(ruleSnapshot(rule));
          if (!options?.silent) showToast("Reminder settings saved (demo).");
          reportSaveStatus({ type: "success" });
          return true;
        }
        const res = await fetch("/api/portal/reminder-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          // A house PATCH edits that house's own override (created on first edit);
          // "" edits the workspace and never touches a house override.
          body: JSON.stringify({
            kind,
            rule,
            ...(scopePropertyId ? { propertyId: scopePropertyId } : {}),
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
          }),
          // A hard page unload can abort an ordinary in-flight fetch before it lands — exactly
          // the write the `pagehide`/`visibilitychange` flush in `settings-module-page.tsx`
          // exists to send.
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: unknown;
          error?: string;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not save reminder settings.");
        const settings = normalizeReminderSettings(body.settings);
        const next = settings.rules[kind];
        setRule(next);
        setSavedSnapshot(ruleSnapshot(next));
        reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
        reportSource(sourceNamespace, body.source);
        if (!options?.silent) showToast("Reminder settings saved.");
        reportSaveStatus({ type: "success" });
        return true;
      } catch (e) {
        // Unconditional — silent only suppresses the SUCCESS toast, never the
        // failure one. A per-control autosave that fails must still surface.
        const message = e instanceof Error ? e.message : "Could not save reminder settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [
      demo,
      isDirty,
      kind,
      reportSaveStatus,
      rule,
      showToast,
      scopePropertyId,
      scopeWorkspaceId,
      scopeKey,
      sourceNamespace,
      reportOverriddenPropertyIds,
      reportSource,
    ],
  );

  const saveIfDirty = useCallback(async (): Promise<boolean> => save({ silent: true }), [save]);

  useImperativeHandle(formRef, () => ({ saveIfDirty }), [saveIfDirty]);

  // "Reset to workspace default" (scope bar) bumps `resetSignal`. When a house is
  // selected, drop its reminder override and reload the workspace value. Fire only
  // when the signal actually advances past the value seen on mount — a boolean
  // "skip first run" ref is NOT safe here because React StrictMode double-invokes
  // the effect on mount (the ref survives the simulated remount), which would fire
  // a reset on load and silently wipe the house's override.
  const lastResetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetRef.current) return;
    lastResetRef.current = resetSignal;
    const targets = scopePropertyIds.length > 0 ? scopePropertyIds : scopePropertyId ? [scopePropertyId] : [];
    if (targets.length === 0 || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        let last: { settings?: unknown; overriddenPropertyIds?: string[] } | null = null;
        for (const target of targets) {
          const res = await fetch("/api/portal/reminder-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: target, reset: true }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            settings?: unknown;
            error?: string;
            overriddenPropertyIds?: string[];
          };
          if (!res.ok) throw new Error(body.error ?? "Could not reset reminder settings.");
          last = body;
        }
        if (!cancelled && last) {
          const settings = normalizeReminderSettings(last.settings);
          const next = settings.rules[kind];
          setRule(next);
          setSavedSnapshot(ruleSnapshot(next));
          reportOverriddenPropertyIds(scopeKey, last.overriddenPropertyIds ?? []);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not reset reminder settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when a reset is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

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

  // A debounced write still pending when this panel goes away (tab switch the host didn't
  // explicitly flush, or leaving Settings outright) must still land — see
  // `useFlushSettingsAutosaveOnUnmount`'s own doc comment for why this has to live here and not
  // one level up.
  useFlushSettingsAutosaveOnUnmount(save, isDirty);

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
  const teamLockedReason = "Add co-managers under Workspaces to notify them here.";

  const channelDataAttr = `reminder-rule-${kind}-channels`;
  const onChannelChange = ({ email, sms }: { email: boolean; sms: boolean }) =>
    // `inbox: true` — the durable record cannot be switched off from this panel;
    // see `ReminderRuleSendViaSelect` above.
    patchRule({ inbox: true, email, sms });

  return (
    <>
      <div className="space-y-4">
        {sectionTitle ? <p className="text-[13.5px] font-semibold text-foreground">{sectionTitle}</p> : null}

        <PortalSettingsGroup>
          <PortalSettingsRow
            label="Send reminders"
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
                      >
                        <PortalSettingsToggle
                          checked={rule.audience.manager}
                          onChange={(next) => patchRule({ audience: { ...rule.audience, manager: next } })}
                          label={`Notify ${meta.notifyYouLabel}`}
                          disabled={disabled}
                          dataAttr={`reminder-rule-${kind}-notify-manager`}
                        />
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyYouLabel} reason={managerLockedReason} />
                    )}

                    {showTeamOption ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyTeamLabel}
                      >
                        <PortalSettingsToggle
                          checked={rule.audience.team}
                          onChange={(next) => patchRule({ audience: { ...rule.audience, team: next } })}
                          label={`Notify ${meta.notifyTeamLabel}`}
                          disabled={disabled}
                          dataAttr={`reminder-rule-${kind}-notify-team`}
                        />
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyTeamLabel} reason={teamLockedReason} />
                    )}

                    {showCounterpartyAudience ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyCounterpartyLabel}
                      >
                        <PortalSettingsToggle
                          checked={rule.audience.counterparty}
                          onChange={(next) => patchRule({ audience: { ...rule.audience, counterparty: next } })}
                          label={`Notify ${meta.notifyCounterpartyLabel}`}
                          disabled={disabled}
                          dataAttr={`reminder-rule-${kind}-notify-counterparty`}
                        />
                      </PortalSettingsRow>
                    ) : (
                      <PortalSettingsLockedRow label={meta.notifyCounterpartyLabel} reason={counterpartyLockedReason} />
                    )}

                    {/* The dispatched vendor, only on kinds that have one (PLAN-0915). */}
                    {meta.notifyVendorLabel && VENDOR_AUDIENCE_KINDS.has(kind) ? (
                      <PortalSettingsRow
                        className="flex-wrap items-start gap-y-2.5"
                        label={meta.notifyVendorLabel}
                      >
                        <PortalSettingsToggle
                          checked={rule.audience.vendor}
                          onChange={(next) => patchRule({ audience: { ...rule.audience, vendor: next } })}
                          label={`Notify ${meta.notifyVendorLabel}`}
                          disabled={disabled}
                          dataAttr={`reminder-rule-${kind}-notify-vendor`}
                        />
                      </PortalSettingsRow>
                    ) : null}

                    {meta.notifyCounterpartyLabel?.toLowerCase() === "assignee" ? null : (
                    <PortalSettingsRow
                      className="flex-wrap items-start gap-y-2.5"
                      label="Assignee"
                    >
                      <PortalSettingsToggle
                        checked={rule.audience.counterparty}
                        onChange={(next) => patchRule({ audience: { ...rule.audience, counterparty: next } })}
                        label="Notify Assignee"
                        disabled={disabled}
                        dataAttr={`reminder-rule-${kind}-notify-assignee`}
                      />
                    </PortalSettingsRow>
                    )}
                  </>
                )}
              </PortalSettingsGroup>

              {channelsFixed && fixed ? (
                <PortalSettingsGroup className="mt-2">
                  <PortalSettingsLockedRow label="Delivery channel" reason={fixed.reason} />
                </PortalSettingsGroup>
              ) : (
                <PortalSettingsGroup className="mt-2">
                  <PortalSettingsRow label="Send via">
                    <ReminderRuleSendViaSelect
                      rule={rule}
                      disabled={disabled}
                      dataAttr={channelDataAttr}
                      onChange={onChannelChange}
                    />
                  </PortalSettingsRow>
                </PortalSettingsGroup>
              )}

              {!audienceFixed && showTeamOption && rule.audience.team ? (
                <div className="mt-3">
                  <CheckboxMultiSelect
                    label="Team members"
                    labelClassName={REMINDER_FIELD_LABEL_CLASS}
                    options={teamMembers.map((member) => ({
                      value: member.userId,
                      label: member.name?.trim() || member.email?.trim() || "Team member",
                    }))}
                    // Empty `teamUserIds` means everyone — shown as everyone ticked.
                    selected={
                      rule.teamUserIds.length === 0
                        ? teamMembers.map((member) => member.userId)
                        : rule.teamUserIds
                    }
                    selectionTriggerLabel={rule.teamUserIds.length === 0 ? "Everyone" : undefined}
                    disabled={disabled}
                    dataAttr={`reminder-rule-${kind}-team-members`}
                    onChange={(next) => {
                      const allIds = teamMembers.map((row) => row.userId);
                      patchRule({
                        teamUserIds: next.length === allIds.length || next.length === 0 ? [] : next,
                      });
                    }}
                  />
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
