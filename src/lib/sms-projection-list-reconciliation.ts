import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

export type SmsProjectionListMutation = {
  updated: Array<{ projectionId: string; archived: boolean; version: number }>;
  deleted: string[];
};

/** Preserve loaded pages while applying exact server-confirmed state versions. */
export function applySmsProjectionListMutation(
  rows: ManagerSmsResidentConversation[],
  mutation: SmsProjectionListMutation,
): ManagerSmsResidentConversation[] {
  const updates = new Map(mutation.updated.map((item) => [item.projectionId, item]));
  const deleted = new Set(mutation.deleted);
  return rows.filter((row) => !row.projectionId || !deleted.has(row.projectionId)).map((row) => {
    const update = row.projectionId ? updates.get(row.projectionId) : undefined;
    if (!update || (row.stateVersion ?? 0) > update.version) return row;
    return { ...row, archived: update.archived, stateVersion: update.version };
  });
}
