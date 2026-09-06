import { createHash, randomBytes } from "node:crypto";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { coManagerOpenInvitePath } from "@/lib/co-manager-invite-path";

export { CO_MANAGER_INVITE_PATH, coManagerOpenInvitePath, isCoManagerInvitePath } from "@/lib/co-manager-invite-path";

/** Opaque, unguessable token. Only the hash is persisted. */
export function generateCoManagerInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCoManagerInviteToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function coManagerOpenInviteUrl(token: string, browserOrigin?: string): string {
  return `${resolveShareableAppOrigin(browserOrigin)}${coManagerOpenInvitePath(token)}`;
}
