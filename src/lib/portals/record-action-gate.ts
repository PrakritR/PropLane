/**
 * The one confirm/Undo gate for a ⋯ menu mutation (PLAN-0920-1058 area 1d,
 * "1d · The pop-up" § Rules: "reversible actions run immediately with an Undo
 * toast, everything else confirms").
 *
 * A tagged action's `reversible` flag (`RecordActionOrderItem.reversible`,
 * `src/lib/portals/record-action-order.ts`) decides the path:
 * - reversible: run it, then show an Undo-capable toast (`useAppUi().showToast`)
 *   that reverts it in one click.
 * - not reversible: ask first through the app's existing confirm
 *   (`useConfirm`), then run it and show a plain toast.
 *
 * Pure — takes the UI functions as arguments so it needs no provider of its
 * own and is trivial to unit test with fakes.
 */

import type { ConfirmRequest } from "@/components/providers/app-ui-provider";

export type RecordActionGate = {
  /** Mirrors `RecordActionOrderItem.reversible` — undoable in one click. */
  reversible?: boolean;
  /** Performs the mutation. */
  run: () => Promise<void> | void;
  /** Reverts it. Required when `reversible` is true — a reversible action with nothing to undo is a content bug. */
  undo?: () => Promise<void> | void;
  /** Toast text shown once `run` has completed. */
  message: string;
  /** Asked first when `reversible` is not set. Omit only for an action with no meaningful confirm copy. */
  confirmRequest?: ConfirmRequest;
};

export type RecordActionGateUi = {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  showToast: (message: string, options?: { undo?: () => void | Promise<void> }) => void;
};

/**
 * Runs a tagged action through the one gate. Resolves `true` once the action
 * ran (whether or not it is later undone), `false` when a required confirm
 * was declined.
 */
export async function runRecordActionGate(gate: RecordActionGate, ui: RecordActionGateUi): Promise<boolean> {
  if (!gate.reversible) {
    if (gate.confirmRequest && !(await ui.confirm(gate.confirmRequest))) return false;
    await gate.run();
    ui.showToast(gate.message);
    return true;
  }
  await gate.run();
  ui.showToast(gate.message, gate.undo ? { undo: gate.undo } : undefined);
  return true;
}
