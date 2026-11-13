import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCommandCatalog } from "@/lib/manager-sms-commands/catalog.server";
import { buildCommandContext, phoneBelongsToActor } from "@/lib/manager-sms-commands/context.server";
import { parseManagerIntent, parseRelayShape, type EditIntent } from "@/lib/manager-sms-commands/intent";
import {
  advanceListingFlow,
  endFlow,
  FIRST_QUESTION,
  loadFlow,
  looksLikeAddress,
  newFlowId,
  saveFlow,
  type FlowRow,
} from "@/lib/manager-sms-commands/listing-flow.server";
import { filePhotos } from "@/lib/manager-sms-commands/photo-filing.server";
import { proposeToolWrite, withdrawOpenProposals } from "@/lib/manager-sms-commands/propose.server";
import { mintReplyHandleFor, nudgeReply, relayReply } from "@/lib/manager-sms-commands/reply-relay.server";
import { resolveTarget, type CatalogProperty } from "@/lib/manager-sms-commands/resolve-target";
import { draftIdFor } from "@/lib/one-number/onboarding/house-draft.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { buildManagerSmsRegistry } from "@/lib/tools";

/**
 * Manager commands by text (design-1112 section 3.3 and 4). Deterministic first, the manager agent second: a verified
 * manager or staff phone can create a draft listing step by step, change a rent / availability date / description,
 * reply to a prospect from an alert text, and file MMS photos into a listing. Anything else is `{ handled: false }` and
 * the manager agent answers as before.
 *
 * Authority: the caller (the inbound pipeline) passes only an identity it already resolved; this re-proves the phone
 * belongs to the actor, and every change runs under that actor's own context through the typed tool layer
 * (`previewWriteTool` + the pending-action confirmation), never raw SQL. Ambiguity is one clarifying line, never a guess.
 */
export type ManagerCommandResult = { handled: false } | { handled: true; reply: string; media?: string[] };

export type ManagerCommandInput = {
  staffPhoneE164: string;
  actorUserId: string;
  /** Every workspace this verified phone may run. */
  workspaceIds: string[];
  body: string;
  messageSid: string;
  mediaCount: number;
  onPropLaneLine: boolean;
};

const NOT_HANDLED: ManagerCommandResult = { handled: false };
const say = (reply: string): ManagerCommandResult => ({ handled: true, reply });
const NOT_BY_TEXT = "I can not do that by text for your access. Please do it in PropLane.";

export async function handleManagerSmsCommand(db: SupabaseClient, input: ManagerCommandInput): Promise<ManagerCommandResult> {
  try {
    return await run(db, input);
  } catch (error) {
    // Never the phone number or the body: those are PII.
    console.error("manager sms command failed", error instanceof Error ? error.message : "unknown");
    return NOT_HANDLED;
  }
}

export async function mintReplyHandle(
  db: SupabaseClient,
  input: { staffPhoneE164: string; workspaceId: string; threadId: string; counterpartyPhoneE164: string },
): Promise<string | null> {
  return mintReplyHandleFor(db, input);
}

async function run(db: SupabaseClient, input: ManagerCommandInput): Promise<ManagerCommandResult> {
  const workspaceIds = [...new Set((input.workspaceIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const body = String(input.body ?? "").trim();
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  if (!staffKey || workspaceIds.length === 0 || (!body && input.mediaCount === 0)) return NOT_HANDLED;
  // A phone that is not the verified phone of this actor gets nothing: no read, no reply, no write.
  if (!(await phoneBelongsToActor(db, input))) return NOT_HANDLED;

  const intent = parseManagerIntent(body);

  // 1. An open guided flow owns the next answer.
  const flow = await loadFlow(db, staffKey);
  if (flow && workspaceIds.includes(flow.workspaceId)) {
    const flowReply = await continueFlow(db, input, flow, intent.kind, body);
    if (flowReply) return flowReply;
  } else if (flow) {
    await endFlow(db, staffKey);
  }

  // 2. A bare YES / NO / code is the existing confirmation path (the manager agent turn), never a command.
  if (intent.kind === "confirmation") return NOT_HANDLED;

  // 3. "K7 <answer>": reply to a prospect.
  if (parseRelayShape(body)) {
    const relayed = await relayReply(db, { staffPhoneE164: input.staffPhoneE164, actorUserId: input.actorUserId, workspaceIds, body, messageSid: input.messageSid });
    if (relayed.handled) return relayed;
  }

  if (intent.kind === "start_listing") return startFlow(db, input, workspaceIds, body);

  // 4. Photos that arrive with this text.
  if (input.mediaCount > 0) {
    const catalog = await loadCommandCatalog(db, workspaceIds);
    const filed = await filePhotos(db, { ...input, workspaceIds, body }, catalog);
    if (filed.handled) return filed;
    return NOT_HANDLED;
  }

  // 5. Edit a price, availability date or description.
  if (intent.kind === "edit") return editListing(db, input, workspaceIds, intent);

  // 6. A text that answers "which house are these photos for?".
  if (body) {
    const catalog = await loadCommandCatalog(db, workspaceIds);
    if (catalog && catalog.length > 0) {
      const filed = await filePhotos(db, { ...input, workspaceIds, body }, catalog);
      if (filed.handled) return filed;
    }
  }

  // 7. Last: a short answer-shaped text with one fresh alert and no handle gets one question back.
  const nudged = await nudgeReply(db, { staffPhoneE164: input.staffPhoneE164, body });
  return nudged.handled ? nudged : NOT_HANDLED;
}

// ---- guided create-a-listing -------------------------------------------------------------------------------------

async function continueFlow(
  db: SupabaseClient,
  input: ManagerCommandInput,
  flow: FlowRow,
  intentKind: string,
  body: string,
): Promise<ManagerCommandResult | null> {
  const staffKey = flow.staffPhoneKey;
  if (intentKind === "cancel") {
    await endFlow(db, staffKey);
    const ctx = await buildCommandContext(db, { actorUserId: input.actorUserId, workspaceId: flow.workspaceId });
    if (ctx) await withdrawOpenProposals(db, ctx);
    return say("Cancelled. Nothing was saved.");
  }
  if (flow.step === "confirm" || flow.step === "photos") {
    // The draft proposal is answered by the existing code confirmation. Anything else ends the flow and is read normally,
    // except that a NO also ends it (the agent turn denies the proposal).
    if (intentKind === "confirmation") {
      if (/^\s*(?:no|n|nope)\b/i.test(body)) await endFlow(db, staffKey);
      return null;
    }
    // Photos texted right after the draft belong to it: the flow is what tells the filer which house.
    if (flow.step === "confirm" && input.mediaCount === 0) await endFlow(db, staffKey);
    return null;
  }
  if (intentKind === "start_listing") return startFlow(db, input, [flow.workspaceId], body, true);
  const advance = advanceListingFlow(flow.step, flow.draft, body);
  if (advance.kind === "stay") return say(advance.reply);
  if (advance.kind === "next") {
    await saveFlow(db, { staffPhoneKey: staffKey, workspaceId: flow.workspaceId, step: advance.step, draft: advance.draft, propertyId: null });
    return say(advance.reply);
  }
  const ctx = await buildCommandContext(db, { actorUserId: input.actorUserId, workspaceId: flow.workspaceId });
  if (!ctx) {
    await endFlow(db, staffKey);
    return say(NOT_BY_TEXT);
  }
  const proposed = await proposeToolWrite(db, ctx, {
    toolName: "create_listing_draft_by_text",
    input: {
      flowId: advance.draft.flowId,
      address: advance.draft.address,
      roomCount: advance.draft.roomCount,
      rentsUsd: advance.draft.rentsUsd,
      ...(advance.draft.details ? { details: advance.draft.details } : {}),
    },
    requireConfirmationCode: input.onPropLaneLine,
  });
  if (!proposed.ok) {
    await endFlow(db, staffKey);
    return say(`${proposed.reply} Text "new listing" to try again.`);
  }
  await saveFlow(db, {
    staffPhoneKey: staffKey,
    workspaceId: flow.workspaceId,
    step: "confirm",
    draft: { ...advance.draft, draftPropertyId: draftIdFor(ctx.landlordId, advance.draft.flowId) },
    propertyId: null,
  });
  return say(proposed.reply);
}

async function workspaceForNewListing(
  db: SupabaseClient,
  workspaceIds: string[],
  body: string,
): Promise<{ id: string } | { ask: string }> {
  if (workspaceIds.length === 1) return { id: workspaceIds[0]! };
  const { data } = await db.from("portal_workspaces").select("id, name").in("id", workspaceIds);
  const rows = ((data ?? []) as Array<{ id: string; name: string }>).map((w) => ({ id: String(w.id), name: String(w.name ?? "").trim() }));
  const text = body.toLowerCase();
  const named = rows.filter((w) => w.name && text.includes(w.name.toLowerCase().replace(/^\d+\.\s*/, "")));
  if (named.length === 1) return { id: named[0]!.id };
  const names = rows.map((w) => w.name.replace(/^\d+\.\s*/, "")).filter(Boolean);
  return { ask: `Which workspace is the new listing for: ${names.slice(0, -1).join(", ")}${names.length > 1 ? " or " : ""}${names[names.length - 1] ?? ""}? Text "new listing for <name>".` };
}

async function startFlow(
  db: SupabaseClient,
  input: ManagerCommandInput,
  workspaceIds: string[],
  body: string,
  restart = false,
): Promise<ManagerCommandResult> {
  const picked = await workspaceForNewListing(db, workspaceIds, body);
  if ("ask" in picked) return say(picked.ask);
  const ctx = await buildCommandContext(db, { actorUserId: input.actorUserId, workspaceId: picked.id });
  if (!ctx || !buildManagerSmsRegistry(ctx.managerSmsAccess).has("create_listing_draft_by_text")) {
    return say("I can not create a listing by text for your access. Please add it in PropLane.");
  }
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  const inline = /\b(?:at|for)\s+(\d[^?]{4,})$/i.exec(body)?.[1]?.trim();
  const draft = { flowId: newFlowId() };
  if (inline && looksLikeAddress(inline)) {
    await saveFlow(db, { staffPhoneKey: staffKey, workspaceId: picked.id, step: "rooms", draft: { ...draft, address: inline.replace(/\s+/g, " ") }, propertyId: null });
    return say("How many rooms are for rent?");
  }
  await saveFlow(db, { staffPhoneKey: staffKey, workspaceId: picked.id, step: "address", draft, propertyId: null });
  return say(restart ? `Starting over. ${FIRST_QUESTION}` : FIRST_QUESTION);
}

// ---- edits -------------------------------------------------------------------------------------------------------

function editCall(intent: EditIntent, property: CatalogProperty, roomName: string | null): { toolName: string; input: Record<string, unknown> } {
  if (intent.field === "rent") {
    return roomName
      ? { toolName: "update_room_rent", input: { propertyId: property.id, roomName, rentUsd: intent.rentUsd } }
      : { toolName: "update_property", input: { propertyId: property.id, rentUsd: intent.rentUsd } };
  }
  if (intent.field === "available") {
    return { toolName: "update_listing_details", input: { propertyId: property.id, ...(roomName ? { roomName } : {}), availableOn: intent.availableOn } };
  }
  return {
    toolName: "update_listing_details",
    input: { propertyId: property.id, ...(roomName ? { roomName } : {}), detail: intent.text, mode: intent.mode },
  };
}

async function editListing(db: SupabaseClient, input: ManagerCommandInput, workspaceIds: string[], intent: EditIntent): Promise<ManagerCommandResult> {
  const catalog = await loadCommandCatalog(db, workspaceIds);
  if (!catalog) return say("I could not read your listings just now. Try again in a minute.");
  const resolved = resolveTarget(intent.targetText, catalog, intent.field === "rent" ? "rent" : intent.field === "available" ? "available" : "description");
  if (resolved.kind === "ask") return say(resolved.question);
  const ctx = await buildCommandContext(db, { actorUserId: input.actorUserId, workspaceId: resolved.property.workspaceId });
  if (!ctx) return say(NOT_BY_TEXT);
  const call = editCall(intent, resolved.property, resolved.room?.name ?? null);
  const proposed = await proposeToolWrite(db, ctx, { ...call, requireConfirmationCode: input.onPropLaneLine });
  return say(proposed.reply);
}
