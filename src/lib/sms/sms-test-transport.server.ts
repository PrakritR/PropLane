import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type SmsTestCapturedEffect = {
  kind: "sms" | "push" | "email" | "calendar" | "reminder" | "manager_notification" | "webhook";
  summary: string;
  status: "captured" | "refused";
  metadata?: Record<string, string | number | boolean | null>;
  workspaceId?: string;
};

export type SmsTestTransportContext = {
  actorUserId: string;
  managerUserId: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  effects: SmsTestCapturedEffect[];
};

const storage = new AsyncLocalStorage<SmsTestTransportContext>();

export function currentSmsTestTransport(): SmsTestTransportContext | null {
  return storage.getStore() ?? null;
}

export function captureSmsTestDelivery(effect: SmsTestCapturedEffect): boolean {
  const context = currentSmsTestTransport();
  if (!context) return false;
  context.effects.push({
    ...effect,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
  });
  return true;
}

export async function runWithSmsTestTransport<T>(
  identity: Omit<SmsTestTransportContext, "effects">,
  run: () => Promise<T>,
): Promise<{ result: T; effects: SmsTestCapturedEffect[] }> {
  const context: SmsTestTransportContext = { ...identity, effects: [] };
  const result = await storage.run(context, run);
  return { result, effects: [...context.effects] };
}
