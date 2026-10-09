import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  apiPostingChannelIds,
  listingChannelAvailability,
  listingChannelDef,
  type ListingChannelId,
  type ListingChannelPendingAction,
  type ListingChannelPostState,
} from "@/lib/listing-channels/registry";
import {
  buildListingPostText,
  listingChannelEligibility,
  listingPostPhotoUrls,
  type ListingHoldReason,
  type ListingPostContact,
} from "@/lib/listing-channels/post-text";
import {
  loadMetaConnection,
  markMetaConnectionRevoked,
  type MetaConnection,
} from "@/lib/listing-channels/meta/connection.server";
import {
  deleteMetaPost,
  MetaGraphError,
  publishInstagramPhoto,
  publishMetaPagePhoto,
} from "@/lib/listing-channels/meta/graph.server";
import { resolveWorkspaceListingAttribution } from "@/lib/listing-attribution.server";
import { asProperty, publicListingProjection } from "@/lib/public-listings.server";
import { resolveActiveManagerWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/** After this many failed tries a post stops retrying and the row says why. */
export const LISTING_CHANNEL_MAX_ATTEMPTS = 5;

type PostRow = {
  id: string;
  manager_user_id: string;
  workspace_id: string | null;
  property_id: string;
  channel: string;
  enabled: boolean;
  state: ListingChannelPostState;
  pending_action: ListingChannelPendingAction | null;
  external_id: string | null;
  last_error: string | null;
  content_hash: string | null;
  attempts: number;
  next_attempt_at: string | null;
  posted_at: string | null;
  updated_at: string;
};

const POST_COLUMNS =
  "id, manager_user_id, workspace_id, property_id, channel, enabled, state, pending_action, external_id, last_error, content_hash, attempts, next_attempt_at, posted_at, updated_at";

export type SyncListing = {
  propertyId: string;
  managerUserId: string;
  workspaceId: string | null;
  live: boolean;
  /** `publicListingProjection` output; the only shape a post is built from. */
  projected: MockProperty;
};

/** The stored listing through the public allowlist, with who owns it. Null when missing or malformed. */
export async function loadSyncListing(db: SupabaseClient, propertyId: string): Promise<SyncListing | null> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id, status, property_data")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data?.manager_user_id) return null;
  const property = asProperty(data.property_data, String(data.id));
  if (!property) return null;
  return {
    propertyId: String(data.id),
    managerUserId: String(data.manager_user_id),
    workspaceId: (data.workspace_id as string | null) ?? null,
    live: data.status === "live",
    projected: publicListingProjection(property),
  };
}

/** The workspace work number and work email, resolved server-side. Never the stored blob's copy. */
export async function resolveListingPostContact(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId: string | null,
): Promise<ListingPostContact> {
  const [phone, email] = await Promise.all([
    resolveActiveManagerSendNumber(db, managerUserId, workspaceId).catch(() => null),
    resolveActiveManagerWorkEmail(db, managerUserId, workspaceId).catch(() => null),
  ]);
  return { phone, email };
}

export function listingPostContentHash(text: string, photoUrl: string | undefined): string {
  return createHash("sha256").update(`${text}\n${photoUrl ?? ""}`).digest("hex");
}

function holdReasons(projected: MockProperty, contact: ListingPostContact): ListingHoldReason[] {
  const reasons = listingChannelEligibility(projected);
  if (!contact.phone?.trim()) reasons.push("no_work_number");
  return reasons;
}

function liveApiChannels(): ListingChannelId[] {
  return apiPostingChannelIds().filter((id) => {
    const def = listingChannelDef(id);
    return def ? listingChannelAvailability(def) === "live" : false;
  });
}

/** Is a channel's account connected for this workspace? Facebook Page needs a Page; Instagram needs a linked Instagram account. */
function connectionServesChannel(connection: MetaConnection, channel: ListingChannelId): boolean {
  if (channel === "facebook_page") return Boolean(connection.pageId);
  if (channel === "instagram") return Boolean(connection.igAccountId);
  return false;
}

async function upsertRow(db: SupabaseClient, row: Partial<PostRow> & Pick<PostRow, "manager_user_id" | "workspace_id" | "property_id" | "channel">) {
  const { error } = await db
    .from("listing_channel_posts")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "property_id,channel" });
  if (error) throw new Error(error.message);
}

/**
 * Bring this listing's channel rows in line with the listing: publish, update on a changed post,
 * unpublish when it goes off the market or the manager turns a channel off. Default is ON for every
 * connected live channel on a new listing; a manager turns one off per listing. Queued, not sent:
 * `processListingChannelQueue` does the calls (with retries).
 */
export async function syncListingChannelsForProperty(
  db: SupabaseClient,
  propertyId: string,
  opts?: { deleted?: boolean },
): Promise<void> {
  if (opts?.deleted) {
    const { data } = await db.from("listing_channel_posts").select(POST_COLUMNS).eq("property_id", propertyId);
    for (const row of (data ?? []) as PostRow[]) {
      if (row.state === "posted" && row.external_id) {
        await db.from("listing_channel_posts").update({ pending_action: "unpublish", attempts: 0, next_attempt_at: null, updated_at: new Date().toISOString() }).eq("id", row.id);
      } else {
        await db.from("listing_channel_posts").delete().eq("id", row.id);
      }
    }
    return;
  }

  const channels = liveApiChannels();
  if (channels.length === 0) return;

  const listing = await loadSyncListing(db, propertyId);
  if (!listing?.workspaceId) return;
  const connection = await loadMetaConnection(db, listing.workspaceId);
  if (!connection) return;

  const { data: existingRows } = await db.from("listing_channel_posts").select(POST_COLUMNS).eq("property_id", propertyId);
  const rows = (existingRows ?? []) as PostRow[];
  const contact = await resolveListingPostContact(db, listing.managerUserId, listing.workspaceId);
  const reasons = holdReasons(listing.projected, contact);
  const origin = resolveEmailLinkBaseUrl();
  const { show: attribution } = await resolveWorkspaceListingAttribution(db, listing.managerUserId, listing.workspaceId);
  const photo = listingPostPhotoUrls(listing.projected)[0];
  const base = { manager_user_id: listing.managerUserId, workspace_id: listing.workspaceId, property_id: propertyId };

  for (const channel of channels) {
    if (!connectionServesChannel(connection, channel)) continue;
    const row = rows.find((r) => r.channel === channel);
    // The manager published this ad by hand (while the channel was still coming soon). That marker
    // is theirs to clear with Undo; posting over it would put a second copy of the same ad up.
    if (row?.state === "posted_by_me") continue;
    const enabled = row ? row.enabled : true;
    const posted = row?.state === "posted" && Boolean(row.external_id);

    if (!listing.live || !enabled) {
      if (posted) await upsertRow(db, { ...base, channel, enabled, pending_action: "unpublish", attempts: 0, next_attempt_at: null });
      else if (row && row.pending_action) await upsertRow(db, { ...base, channel, enabled, state: enabled ? row.state : "off", pending_action: null });
      else if (row && !enabled && row.state !== "off") await upsertRow(db, { ...base, channel, enabled, state: "off" });
      continue;
    }

    if (reasons.length > 0) {
      if (!posted) await upsertRow(db, { ...base, channel, enabled, state: "held", pending_action: null, last_error: reasons.join(",") });
      continue;
    }

    const built = buildListingPostText({ property: listing.projected, origin, contact, channel, attribution });
    if (!built.ok) continue;
    const hash = listingPostContentHash(built.text, photo);
    if (posted && row?.content_hash === hash) continue;
    await upsertRow(db, {
      ...base,
      channel,
      enabled,
      state: "pending",
      pending_action: posted ? "update" : "publish",
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
    });
  }
}

async function finishRow(db: SupabaseClient, id: string, patch: Record<string, unknown>) {
  await db.from("listing_channel_posts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/** Meta's API cannot edit or remove an Instagram post; say so rather than pretend. */
const INSTAGRAM_UNSUPPORTED = "Instagram does not let apps edit or remove a post. Change it in Instagram.";

async function runRow(db: SupabaseClient, row: PostRow): Promise<void> {
  const action = row.pending_action;
  const channel = row.channel as ListingChannelId;
  const workspaceId = row.workspace_id;
  if (!action || !workspaceId) return finishRow(db, row.id, { state: "failed", pending_action: null, last_error: "No workspace." });

  const connection = await loadMetaConnection(db, workspaceId);
  if (!connection) {
    return finishRow(db, row.id, { state: "failed", pending_action: null, last_error: "Reconnect Facebook." });
  }

  try {
    if (action === "unpublish") {
      if (channel === "facebook_page" && row.external_id) {
        await deleteMetaPost({ postId: row.external_id, token: connection.pageToken }).catch((e) => {
          // Already gone on Facebook's side is the outcome we wanted.
          if (!(e instanceof MetaGraphError) || e.code !== 100) throw e;
        });
        return finishRow(db, row.id, { state: "off", pending_action: null, external_id: null, last_error: null, attempts: 0 });
      }
      return finishRow(db, row.id, { state: "off", pending_action: null, last_error: channel === "instagram" ? INSTAGRAM_UNSUPPORTED : null, attempts: 0 });
    }

    const listing = await loadSyncListing(db, row.property_id);
    if (!listing || !listing.live) {
      return finishRow(db, row.id, { state: "off", pending_action: null, last_error: null });
    }
    const contact = await resolveListingPostContact(db, listing.managerUserId, listing.workspaceId);
    const reasons = holdReasons(listing.projected, contact);
    if (reasons.length > 0) {
      return finishRow(db, row.id, { state: "held", pending_action: null, last_error: reasons.join(",") });
    }
    const { show: attribution } = await resolveWorkspaceListingAttribution(db, listing.managerUserId, listing.workspaceId);
    const built = buildListingPostText({ property: listing.projected, origin: resolveEmailLinkBaseUrl(), contact, channel, attribution });
    const photo = listingPostPhotoUrls(listing.projected)[0];
    if (!built.ok || !photo) {
      return finishRow(db, row.id, { state: "held", pending_action: null, last_error: "no_photo" });
    }
    const hash = listingPostContentHash(built.text, photo);

    if (channel === "instagram") {
      if (action === "update") {
        return finishRow(db, row.id, { state: "posted", pending_action: null, content_hash: hash, last_error: INSTAGRAM_UNSUPPORTED, attempts: 0 });
      }
      if (!connection.igAccountId) throw new Error("No Instagram account is linked to the connected Page.");
      const id = await publishInstagramPhoto({ igAccountId: connection.igAccountId, token: connection.pageToken, photoUrl: photo, caption: built.text });
      return finishRow(db, row.id, { state: "posted", pending_action: null, external_id: id, content_hash: hash, posted_at: new Date().toISOString(), last_error: null, attempts: 0 });
    }

    if (channel === "facebook_page") {
      if (!connection.pageId) throw new Error("No Facebook Page is connected.");
      if (action === "update" && row.external_id) {
        // Edit = remove the old post and repost: a photo post's caption is not editable through the API.
        await deleteMetaPost({ postId: row.external_id, token: connection.pageToken }).catch(() => undefined);
      }
      const id = await publishMetaPagePhoto({ pageId: connection.pageId, token: connection.pageToken, photoUrl: photo, caption: built.text });
      return finishRow(db, row.id, { state: "posted", pending_action: null, external_id: id, content_hash: hash, posted_at: new Date().toISOString(), last_error: null, attempts: 0 });
    }
    return finishRow(db, row.id, { state: "failed", pending_action: null, last_error: "Unsupported channel." });
  } catch (error) {
    if (error instanceof MetaGraphError && error.needsReconnect) {
      await markMetaConnectionRevoked(db, workspaceId);
      return finishRow(db, row.id, { state: "failed", pending_action: null, last_error: "Reconnect Facebook." });
    }
    const message = (error instanceof Error ? error.message : "Posting failed.").slice(0, 300);
    if (row.attempts >= LISTING_CHANNEL_MAX_ATTEMPTS) {
      return finishRow(db, row.id, { state: "failed", pending_action: null, last_error: message });
    }
    const backoffMinutes = 2 ** row.attempts;
    return finishRow(db, row.id, {
      state: "pending",
      last_error: message,
      next_attempt_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    });
  }
}

/** Drain queued posts, a few at a time. Safe to call from a cron and from a save; a row is claimed before it is worked. */
export async function processListingChannelQueue(
  db: SupabaseClient,
  opts?: { limit?: number; propertyId?: string },
): Promise<{ claimed: number }> {
  if (liveApiChannels().length === 0) return { claimed: 0 };
  let query = db
    .from("listing_channel_posts")
    .select(POST_COLUMNS)
    .not("pending_action", "is", null)
    .lte("attempts", LISTING_CHANNEL_MAX_ATTEMPTS)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order("updated_at", { ascending: true })
    .limit(opts?.limit ?? 10);
  if (opts?.propertyId) query = query.eq("property_id", opts.propertyId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let claimed = 0;
  for (const row of (data ?? []) as PostRow[]) {
    // Compare-and-swap claim: only one worker moves this row out of its queued state.
    const { data: won } = await db
      .from("listing_channel_posts")
      .update({ state: "posting", attempts: row.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("updated_at", row.updated_at)
      .select("id");
    if (!won?.length) continue;
    claimed += 1;
    await runRow(db, { ...row, attempts: row.attempts + 1 });
  }
  return { claimed };
}

/**
 * Called after a property save or delete: sync then drain, off the request path. Best-effort; a
 * failure here never fails the save, and the cron picks up whatever is left.
 */
export function scheduleListingChannelSync(db: SupabaseClient, propertyId: string, opts?: { deleted?: boolean }): void {
  const task = async () => {
    try {
      await syncListingChannelsForProperty(db, propertyId, opts);
      await processListingChannelQueue(db, { propertyId });
    } catch {
      /* the cron retries what the save could not */
    }
  };
  try {
    after(task);
  } catch {
    void task();
  }
}
