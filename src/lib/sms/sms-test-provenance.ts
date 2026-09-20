export const SMS_TEST_PROVENANCE_KEY = "smsTestProvenance" as const;

export type SmsTestProvenance = {
  actorUserId: string;
  managerUserId: string;
  sessionId: string;
  /** Durable test tenancy. Older non-production rows may not have it. */
  workspaceId?: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readSmsTestProvenance(value: unknown): SmsTestProvenance | null {
  const row = object(value);
  if (!row) return null;
  const raw = object(row[SMS_TEST_PROVENANCE_KEY]);
  const actorUserId = String(raw?.actorUserId ?? row.sms_test_actor_user_id ?? row.test_actor_user_id ?? "").trim();
  const managerUserId = String(raw?.managerUserId ?? row.sms_test_manager_user_id ?? row.manager_user_id ?? "").trim();
  const sessionId = String(raw?.sessionId ?? row.smsTestSessionId ?? row.sms_test_session_id ?? row.test_session_id ?? "").trim();
  const workspaceId = String(raw?.workspaceId ?? row.testWorkspaceId ?? row.test_workspace_id ?? row.sms_test_workspace_id ?? "").trim();
  if (!sessionId) return null;
  return { actorUserId, managerUserId, sessionId, ...(workspaceId ? { workspaceId } : {}) };
}

export function hasSmsTestProvenance(value: unknown): boolean {
  return readSmsTestProvenance(value) !== null;
}

/**
 * Compare every part of a durable test identity. Session id alone is not an
 * authorization boundary: an actor can have sessions against several managers.
 */
export function sameSmsTestProvenance(
  left: SmsTestProvenance | null | undefined,
  right: SmsTestProvenance | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.actorUserId === right.actorUserId &&
    left.managerUserId === right.managerUserId &&
    left.sessionId === right.sessionId &&
    (left.workspaceId ?? "") === (right.workspaceId ?? ""),
  );
}

export function withSmsTestProvenance<T extends Record<string, unknown>>(
  value: T,
  provenance: SmsTestProvenance | null,
): T {
  if (!provenance) return value;
  const existing = readSmsTestProvenance(value);
  const immutable = existing
    ? {
        actorUserId: existing.actorUserId || provenance.actorUserId,
        managerUserId: existing.managerUserId || provenance.managerUserId,
        sessionId: existing.sessionId,
        ...((existing.workspaceId || provenance.workspaceId)
          ? { workspaceId: existing.workspaceId || provenance.workspaceId }
          : {}),
      }
    : provenance;
  return {
    ...value,
    smsTestSessionId: immutable.sessionId,
    [SMS_TEST_PROVENANCE_KEY]: immutable,
  };
}

/**
 * Reconcile a client-authored JSON replacement with server-stored provenance.
 * Clients may omit the marker after normalization and may never invent one.
 */
export function preserveStoredSmsTestProvenance<T extends Record<string, unknown>>(
  value: T,
  stored: unknown,
): T {
  const clean = { ...value };
  delete clean.smsTestSessionId;
  delete clean[SMS_TEST_PROVENANCE_KEY];
  delete clean.sms_test_actor_user_id;
  delete clean.sms_test_manager_user_id;
  delete clean.sms_test_session_id;
  delete clean.test_actor_user_id;
  delete clean.test_session_id;
  delete clean.testWorkspaceId;
  delete clean.test_workspace_id;
  delete clean.sms_test_workspace_id;
  return withSmsTestProvenance(clean, readSmsTestProvenance(stored));
}
