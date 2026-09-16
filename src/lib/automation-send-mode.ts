/**
 * Auto-send vs draft-for-review, per manager/workspace-owner (WS5, PLAN-0915
 * phase 5). Replaces the earlier client-only `useState` auto-send toggles
 * (`resident-inbox-panel.tsx` / `vendor-inbox-panel.tsx`) for ACTION-EVENT
 * automation specifically — those component toggles govern AI-drafted manual
 * replies and are untouched by this file.
 *
 * Stored under `manager_automation_settings.row_data.reminderRules` beside
 * `rules`/`quietHours` (`ReminderSettings.automationSendMode`) — the same
 * namespaced blob, no new migration.
 *
 * Scope: `manager_automation_settings` is keyed on `manager_user_id`, i.e. the
 * WORKSPACE OWNER account, so this setting is effectively per-owner today
 * (a Business owner's several workspaces share one row). That already matches
 * every other automation setting in this file's neighborhood
 * (`automated-messages-settings.ts`, `reminders/rules.ts`).
 *
 * Default: `team` auto-sends (a teammate typing "on my way" does not need
 * manager sign-off to reach the team). `partyFacing` (resident/vendor
 * recipients on an action event) intentionally DEFAULTS TO `"auto"` here —
 * NOT the `"draft"` default the approved plan describes — because
 * `emitActionEvent`/`deliverProjection` is the single shared bus every other
 * already-shipped domain (payments, leases, applications, services) also
 * emits through. Flipping the *default* to draft-for-review would silently
 * stop resident/vendor delivery for dozens of already-shipped, already-tested
 * automated messages outside this slice's ownership (WS5/WS6), which is a
 * cross-cutting product change that needs its own coordinated rollout. The
 * `"draft"` mode is fully implemented and can be turned on per workspace from
 * Settings; only the shipped default is the conservative one.
 */

export type AutomationSendMode = "auto" | "draft";

export type AutomationSendModeSettings = {
  /** Messages posted to the manager's Team thread (WS5 team-audience events). */
  team: AutomationSendMode;
  /**
   * Resident/vendor-facing automated messages that opt into draft-for-review
   * (see `draftForReview` on `ActionEventRecipient` — only call sites that set
   * it are affected; everything else keeps auto-sending regardless of this
   * setting, which is what keeps this additive).
   */
  partyFacing: AutomationSendMode;
};

export const DEFAULT_AUTOMATION_SEND_MODE_SETTINGS: AutomationSendModeSettings = {
  team: "auto",
  partyFacing: "auto",
};

function normalizeMode(raw: unknown, fallback: AutomationSendMode): AutomationSendMode {
  return raw === "auto" || raw === "draft" ? raw : fallback;
}

export function normalizeAutomationSendModeSettings(raw: unknown): AutomationSendModeSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    team: normalizeMode(row.team, DEFAULT_AUTOMATION_SEND_MODE_SETTINGS.team),
    partyFacing: normalizeMode(row.partyFacing, DEFAULT_AUTOMATION_SEND_MODE_SETTINGS.partyFacing),
  };
}
