/**
 * One status word for a work-number Channels row (PLAN-0920-1530).
 *
 * The old status card carried real carrier-registration states (request
 * received / pending / rejected) across three separate fields (`state`,
 * `carrierRegistrationState`, `setupNeedsAttention`). A Channels row has room
 * for one short phrase, so this collapses every state into exactly four:
 * `Ready`, `Setting up · carrier registration pending`, `Assigning`, and
 * `Needs attention`.
 *
 * A row for the account's OWN currently-active number can pass the richer
 * `carrierRegistrationState` / `setupNeedsAttention` / `canSend` fields (read
 * from `ManagerMessagingNumberStatus.number` + `.canSend`). A row for another
 * workspace's number only ever carries `WorkspaceNumberEntry.provisionState`
 * — the API does not expose per-number carrier detail for a number the
 * viewer does not own the active read for — so those rows fall back to the
 * coarser mapping keyed on `state` alone. Both shapes funnel through the same
 * function so the four words stay the single source of truth.
 */

export type WorkNumberStatusWord =
  | "Ready"
  | "Setting up · carrier registration pending"
  | "Assigning"
  | "Needs attention";

export type WorkNumberStatusInput = {
  /** `ManagerMessagingNumber.state` / `WorkspaceNumberEntry.provisionState`. */
  state?: string | null;
  /** Known only when this row is the viewer's own active number. */
  carrierRegistrationState?: string | null;
  setupNeedsAttention?: boolean | null;
  /** True only when this exact row is confirmed sendable (plan + runtime + provider). */
  canSend?: boolean | null;
};

export function workNumberStatusWord(input: WorkNumberStatusInput): WorkNumberStatusWord {
  if (input.canSend) return "Ready";
  if (input.setupNeedsAttention) return "Needs attention";

  switch (input.state) {
    case "failed":
      return "Needs attention";
    case "released":
      // A retired line should not still be showing as a row at all in the
      // common case, but if one does, treat it the same as any other state
      // that needs a human to look rather than inventing a fifth word.
      return "Needs attention";
    case "provisioning":
      return input.carrierRegistrationState === "failed"
        ? "Needs attention"
        : "Setting up · carrier registration pending";
    case "pending_registration":
      // The request is queued but no number has been purchased yet — nothing
      // to register with a carrier until provisioning starts.
      return "Assigning";
    case "active":
      // Attached and provider-registered. `canSend === false` is only ever
      // passed for a row the caller has full detail on (this deployment has
      // texting switched off, or the plan lapsed) — surface that as needing a
      // look. A foreign row never carries `canSend` at all (`undefined`), so
      // an unqualified "active" defaults to Ready rather than a false alarm.
      return input.canSend === false ? "Needs attention" : "Ready";
    default:
      return "Assigning";
  }
}
