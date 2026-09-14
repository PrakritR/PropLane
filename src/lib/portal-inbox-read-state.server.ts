import { createHash } from "node:crypto";

export type PortalInboxReadRecord = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string | null;
  updated_at: string;
  row_data: unknown;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function portalInboxReadObservation(record: PortalInboxReadRecord): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    id: record.id, scope: record.scope, ownerUserId: record.owner_user_id,
    participantEmail: record.participant_email, threadType: record.thread_type,
    updatedAt: record.updated_at, rowData: record.row_data,
  }))).digest("hex");
}
