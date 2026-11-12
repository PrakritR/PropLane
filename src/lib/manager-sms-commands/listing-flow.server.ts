import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Guided create-a-listing by text (design-1112 section 3.3): address -> rooms -> rent -> details -> confirm, one
 * question at a time, state in `sms_listing_flows` (one open flow per staff phone, 2 hour expiry). The last step does
 * not write: it proposes `create_listing_draft_by_text` through the typed tool layer, so the write is a preview plus
 * the PropLane line's 4-digit code, and the result is a DRAFT (never public). `advanceListingFlow` is pure.
 */

export const LISTING_FLOW_TTL_MS = 2 * 60 * 60 * 1000;

export type ListingFlowStep = "address" | "rooms" | "rent" | "details" | "confirm" | "photos";

export type ListingFlowDraft = {
  flowId: string;
  address?: string;
  roomCount?: number;
  rentsUsd?: number[];
  details?: string | null;
  /** Deterministic id the draft will have once confirmed (`draftIdFor(owner, flowId)`); the photos step files into it. */
  draftPropertyId?: string;
};

type ProposableDraft = Required<Pick<ListingFlowDraft, "address" | "roomCount" | "rentsUsd">> & ListingFlowDraft;

export type FlowAdvance =
  | { kind: "stay"; reply: string }
  | { kind: "next"; step: ListingFlowStep; draft: ListingFlowDraft; reply: string }
  | { kind: "propose"; draft: ProposableDraft };

export const FIRST_QUESTION = "What is the street address of the new listing? Text cancel any time to stop.";

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function parseRoomCount(body: string): number | null {
  const text = body.toLowerCase();
  const digits = /\b(\d{1,2})\b/.exec(text);
  if (digits) {
    const n = Number(digits[1]);
    return n >= 1 && n <= 20 ? n : null;
  }
  for (const [word, n] of Object.entries(WORDS)) if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  return null;
}

export function parseRents(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{1,2})?/g)) {
    const value = Number(m[1]!.replace(/,/g, ""));
    if (value >= 100 && value <= 100000) out.push(Math.round(value));
  }
  return out;
}

export function looksLikeAddress(body: string): boolean {
  const text = body.trim();
  return text.length >= 5 && text.length <= 200 && /\d/.test(text) && /[a-z]{3,}/i.test(text) && !text.endsWith("?");
}

const SKIP = /^(?:skip|none|no|nope|n\/a|nothing|no thanks|pass)[\s.!]*$/i;

/** One answer in, the next step (or a re-ask) out. */
export function advanceListingFlow(step: ListingFlowStep, draft: ListingFlowDraft, rawBody: string): FlowAdvance {
  const body = rawBody.trim();
  if (step === "address") {
    if (!looksLikeAddress(body)) return { kind: "stay", reply: "I need the street address with its number, like 5259 Brooklyn Ave NE. What is it?" };
    return { kind: "next", step: "rooms", draft: { ...draft, address: body.replace(/\s+/g, " ") }, reply: "How many rooms are for rent?" };
  }
  if (step === "rooms") {
    const count = parseRoomCount(body);
    if (!count) return { kind: "stay", reply: "How many rooms are for rent? A number from 1 to 20." };
    return {
      kind: "next",
      step: "rent",
      draft: { ...draft, roomCount: count },
      reply: count === 1 ? "What is the monthly rent?" : `What is the monthly rent? One amount for all ${count} rooms, or ${count} amounts separated by commas.`,
    };
  }
  if (step === "rent") {
    const rents = parseRents(body);
    const roomCount = draft.roomCount ?? 1;
    if (rents.length === 0) return { kind: "stay", reply: "I need the monthly rent in dollars, like 950. What is it?" };
    if (rents.length !== 1 && rents.length !== roomCount) {
      return { kind: "stay", reply: `Give one rent for every room, or ${roomCount} amounts, one per room. What are they?` };
    }
    return { kind: "next", step: "details", draft: { ...draft, rentsUsd: rents }, reply: "Any detail to add to the description? Text skip to leave it blank." };
  }
  if (step === "details") {
    const details = SKIP.test(body) ? null : body.slice(0, 1200);
    const next = { ...draft, details };
    if (!next.address || !next.roomCount || !next.rentsUsd?.length) return { kind: "stay", reply: "Something went missing. Text cancel and start again." };
    return { kind: "propose", draft: next as ProposableDraft };
  }
  return { kind: "stay", reply: "Reply with the code to save the draft, or text cancel." };
}

export function newFlowId(): string {
  return `flow${randomBytes(6).toString("hex")}`;
}

export type FlowRow = { staffPhoneKey: string; workspaceId: string; step: ListingFlowStep; draft: ListingFlowDraft; propertyId: string | null; expiresAt: string };

export async function loadFlow(db: SupabaseClient, staffPhoneKey: string, now: Date = new Date()): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("sms_listing_flows")
    .select("staff_phone_key, workspace_id, step, draft, property_id, expires_at")
    .eq("staff_phone_key", staffPhoneKey)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  if (new Date(String(row.expires_at)).getTime() <= now.getTime()) {
    await db.from("sms_listing_flows").delete().eq("staff_phone_key", staffPhoneKey).then(undefined, () => undefined);
    return null;
  }
  return {
    staffPhoneKey,
    workspaceId: String(row.workspace_id),
    step: String(row.step) as ListingFlowStep,
    draft: ((row.draft ?? {}) as ListingFlowDraft),
    propertyId: row.property_id ? String(row.property_id) : null,
    expiresAt: String(row.expires_at),
  };
}

export async function saveFlow(db: SupabaseClient, flow: Omit<FlowRow, "expiresAt">, now: Date = new Date()): Promise<boolean> {
  const { error } = await db.from("sms_listing_flows").upsert(
    {
      staff_phone_key: flow.staffPhoneKey,
      workspace_id: flow.workspaceId,
      step: flow.step,
      draft: flow.draft,
      property_id: flow.propertyId,
      expires_at: new Date(now.getTime() + LISTING_FLOW_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "staff_phone_key" },
  );
  return !error;
}

export async function endFlow(db: SupabaseClient, staffPhoneKey: string): Promise<void> {
  await db.from("sms_listing_flows").delete().eq("staff_phone_key", staffPhoneKey).then(undefined, () => undefined);
}
