import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DeliveryIssueInput, ProspectContextInput, ProspectRecordView, ProspectSource, RecordInboundInput,
  RecordInboundResult, RecordOutboundInput, StitchResult,
} from "@/lib/prospect-spine/contracts";

/** Prospect spine (design-1112 §3.0). Stubs: Package A replaces every body. */

export function contextLabel(input: { propertyLabel: string | null; roomLabel?: string | null; sourceLabel?: string | null }): string {
  throw new Error("prospect-spine: not built");
}

export async function recordInbound(db: SupabaseClient, input: RecordInboundInput): Promise<RecordInboundResult> {
  throw new Error("prospect-spine: not built");
}

export async function recordOutbound(db: SupabaseClient, input: RecordOutboundInput): Promise<{ ok: boolean; messageId?: string }> {
  throw new Error("prospect-spine: not built");
}

export async function recordDeliveryIssue(db: SupabaseClient, input: DeliveryIssueInput): Promise<void> {
  throw new Error("prospect-spine: not built");
}

export async function clearDeliveryIssue(db: SupabaseClient, threadId: string): Promise<void> {
  throw new Error("prospect-spine: not built");
}

export async function resolveInboundContext(db: SupabaseClient, input: { workspaceId: string; ownerUserId: string; phoneE164: string; body: string; payloadPropertyId?: string | null }): Promise<ProspectContextInput> {
  throw new Error("prospect-spine: not built");
}

export async function loadProspectRecord(db: SupabaseClient, key: { phoneE164: string } | { userId: string }): Promise<ProspectRecordView | null> {
  throw new Error("prospect-spine: not built");
}

export async function linkAccountToProspectRecord(db: SupabaseClient, input: { userId: string; phoneE164: string }): Promise<{ linked: boolean; threads: number }> {
  throw new Error("prospect-spine: not built");
}

export async function mintStitchCode(db: SupabaseClient, contextId: string): Promise<string | null> {
  throw new Error("prospect-spine: not built");
}

export async function stitchByCode(db: SupabaseClient, input: { code: string; phoneE164: string; workspaceId: string }): Promise<StitchResult> {
  throw new Error("prospect-spine: not built");
}

export async function stitchByPhone(db: SupabaseClient, input: { contextId: string; phoneE164: string }): Promise<StitchResult> {
  throw new Error("prospect-spine: not built");
}

export async function resolveSmsPayer(db: SupabaseClient, input: { ownerUserId: string; workspaceId: string | null }): Promise<string> {
  throw new Error("prospect-spine: not built");
}

export async function sourceReport(db: SupabaseClient, input: { workspaceId: string; propertyId?: string | null; since?: string | null }): Promise<Array<{ source: ProspectSource; leads: number; onPlatform: number; movedToSms: number; withAccount: number }>> {
  throw new Error("prospect-spine: not built");
}
