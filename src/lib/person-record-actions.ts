/**
 * Stage-aware list and header actions for a manager person record
 * (resident or vendor). One helper so the ⋯ menu, Needs you, and the
 * round title icons cannot disagree.
 *
 * Reminder priority when several stages are open: application > lease > tour.
 */

export type PersonRecordKind = "resident" | "vendor";

export type PersonRecordReminderKind = "application" | "lease" | "tour";

export type PersonRecordActionId = "setup" | "remind" | "edit" | "delete";

export type PersonRecordListAction = {
  id: PersonRecordActionId;
  label: string;
};

export type PersonRecordActionsInput = {
  kind: PersonRecordKind;
  /** True once the person has a portal login (`vendorUserId` / resident user). */
  hasPortalUser: boolean;
  applicationIncomplete?: boolean;
  leaseUnsigned?: boolean;
  tourPending?: boolean;
};

export function personRecordReminderKind(
  input: Pick<PersonRecordActionsInput, "applicationIncomplete" | "leaseUnsigned" | "tourPending">,
): PersonRecordReminderKind | null {
  if (input.applicationIncomplete) return "application";
  if (input.leaseUnsigned) return "lease";
  if (input.tourPending) return "tour";
  return null;
}

export function personRecordReminderLabel(kind: PersonRecordReminderKind | null): string | null {
  if (kind === "application") return "Remind to finish application";
  if (kind === "lease") return "Remind to sign lease";
  if (kind === "tour") return "Remind for tour";
  return null;
}

export function personRecordListActions(input: PersonRecordActionsInput): PersonRecordListAction[] {
  const actions: PersonRecordListAction[] = [];
  if (!input.hasPortalUser) {
    actions.push({ id: "setup", label: "Send setup" });
  }
  const reminderLabel = personRecordReminderLabel(personRecordReminderKind(input));
  if (reminderLabel) {
    actions.push({ id: "remind", label: reminderLabel });
  }
  actions.push({ id: "edit", label: "Edit" });
  actions.push({ id: "delete", label: input.kind === "vendor" ? "Remove" : "Delete" });
  return actions;
}

export type PersonRecordNeedsYouItem = {
  id: "setup" | "remind";
  title: string;
  detail: string;
};

/** Extra Needs you rows for setup / the open stage reminder. */
export function personRecordNeedsYouItems(input: PersonRecordActionsInput): PersonRecordNeedsYouItem[] {
  const items: PersonRecordNeedsYouItem[] = [];
  if (!input.hasPortalUser) {
    items.push({
      id: "setup",
      title: "Send setup",
      detail: "They do not have a PropLane login yet",
    });
  }
  const kind = personRecordReminderKind(input);
  const label = personRecordReminderLabel(kind);
  if (label && kind) {
    items.push({
      id: "remind",
      title: label,
      detail:
        kind === "application"
          ? "Application is still incomplete"
          : kind === "lease"
            ? "Lease is waiting on a signature"
            : "A tour still needs them",
    });
  }
  return items;
}
