/**
 * Stable identity for the system prompt that produced a turn. A character
 * count alone cannot answer "did the prompt change?"; the SHA-256 of the exact
 * string does, and the release SHA answers "which deploy shipped it."
 *
 * Prompts stay repo-owned — this metadata is stamped onto traces so quality
 * drops can be attributed. It is not Langfuse Prompt Management.
 */
import { createHash } from "node:crypto";

export type AgentPromptMeta = {
  promptId: string;
  promptHash: string;
  release: string;
};

/** Known prompt ids. Bump only when deliberately renaming a surface. */
export const PROMPT_IDS = {
  managerAssistant: "manager-assistant",
  residentAssistant: "resident-assistant",
  vendorAssistant: "vendor-assistant",
  vendorSmsAgent: "vendor-sms-agent",
  leasingSmsAgent: "leasing-sms-agent",
  residentSmsAgent: "resident-sms-agent",
  managerSmsAgent: "manager-sms-agent",
  managerVoiceAgent: "manager-voice-agent",
  residentInboxAgent: "resident-inbox-agent",
  inboxDraftReply: "inbox-draft-reply",
  housingSearchExtract: "housing-search-extract",
  generalAssistant: "general-assistant",
} as const;

export type PromptId = (typeof PROMPT_IDS)[keyof typeof PROMPT_IDS];

/** SHA-256 hex of the exact system string the model receives. */
export function hashSystemPrompt(system: string): string {
  return createHash("sha256").update(system, "utf8").digest("hex");
}

/**
 * Prefer the Vercel deploy SHA so production traces line up with a commit.
 * Local / non-Vercel falls back to a short env override or "local".
 */
export function resolveReleaseSha(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercel) return vercel.slice(0, 40);
  const override = process.env.AXIS_RELEASE_SHA?.trim();
  if (override) return override.slice(0, 40);
  return "local";
}

export function resolvePromptMeta(promptId: string, system: string): AgentPromptMeta {
  return {
    promptId,
    promptHash: hashSystemPrompt(system),
    release: resolveReleaseSha(),
  };
}
