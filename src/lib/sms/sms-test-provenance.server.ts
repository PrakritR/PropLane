import "server-only";

import { currentSmsTestTransport } from "./sms-test-transport.server";
import {
  withSmsTestProvenance,
  type SmsTestProvenance,
} from "./sms-test-provenance";

export function currentSmsTestProvenance(): SmsTestProvenance | null {
  const context = currentSmsTestTransport();
  const sessionId = context?.sessionId?.trim();
  if (!context || !sessionId) return null;
  return {
    actorUserId: context.actorUserId,
    managerUserId: context.managerUserId,
    sessionId,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
  };
}

export function stampSmsTestProvenance<T extends Record<string, unknown>>(value: T): T {
  return withSmsTestProvenance(value, currentSmsTestProvenance());
}

export function smsTestProvenanceColumns(): Record<string, string> {
  const provenance = currentSmsTestProvenance();
  if (!provenance) return {};
  return {
    sms_test_actor_user_id: provenance.actorUserId,
    sms_test_manager_user_id: provenance.managerUserId,
    sms_test_session_id: provenance.sessionId,
    ...(provenance.workspaceId ? { sms_test_workspace_id: provenance.workspaceId } : {}),
  };
}
