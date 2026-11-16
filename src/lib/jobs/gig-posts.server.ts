import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  GIG_KIND_BOARD_CATEGORY,
  GIG_KIND_LABEL,
  GIG_MAX_CENTS,
  GIG_MIN_CENTS,
  newGigCode,
  type GigKind,
} from "@/lib/jobs/gig-parse";
import { rateLimit } from "@/lib/rate-limit";
import { publishServiceToBoard } from "@/lib/service-work-board.server";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

/**
 * PropLane Jobs: a manager posts a priced job ("show 4709A Room 3 Saturday 2pm, $40"). This is the ONE writer of a posting,
 * for the SMS assistant tool and the portal route alike (same records, same notices):
 *
 *   1. a service in `portal_work_order_records` (the EXISTING services system: Open · Assigned · Scheduled · Completed, one
 *      vocabulary from `service-lifecycle.ts`; the category is Tours or Cleaning, which the board already has),
 *   2. a `gig_posts` row (the offered price, a short reply code, the general area, never anything private),
 *   3. the service published to the vendor work board with the price as its budget (`publishServiceToBoard`).
 *
 * The home is re-derived from the manager's OWN property records by id; nothing here trusts a model or a body for ownership.
 * Offers to vendors (`gig-offers.server.ts`) are a separate step so a failed text never undoes a saved posting.
 */

type Db = SupabaseClient;

export const GIG_POSTS_PER_MANAGER_PER_DAY = 6;

export type GigHome = { id: string; label: string; address: string; zip: string | null };

/** The manager's own home by id. Null = not theirs (or no such home). */
export async function loadOwnedGigHome(db: Db, managerUserId: string, propertyId: string): Promise<GigHome | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await db.from("manager_property_records").select("id, status, row_data").eq("id", id).eq("manager_user_id", managerUserId).maybeSingle();
  if (error || !data) return null;
  const src = ((data as { row_data?: unknown }).row_data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const address = str(src.address) || str((src.submission as Record<string, unknown> | undefined)?.address);
  const zip = str(src.zip) || str((src.submission as Record<string, unknown> | undefined)?.zip) || (/\b(\d{5})(?:-\d{4})?\b/.exec(address)?.[1] ?? "");
  const label = str(src.title) || str(src.buildingName) || str(src.name) || address || id;
  return { id: String((data as { id: unknown }).id), label, address, zip: zip || null };
}

/** The manager's homes whose address or name starts with / contains the street number in the text. */
export async function findOwnedHomesByStreetNumber(db: Db, managerUserId: string, streetNumber: string): Promise<GigHome[]> {
  const want = streetNumber.trim().toLowerCase();
  if (!want) return [];
  const { data, error } = await db.from("manager_property_records").select("id, status, row_data").eq("manager_user_id", managerUserId).limit(200);
  if (error) return [];
  const out: GigHome[] = [];
  for (const record of (data ?? []) as { id: unknown; status?: unknown; row_data?: unknown }[]) {
    const src = (record.row_data ?? {}) as Record<string, unknown>;
    const hay = [src.address, src.title, src.buildingName, src.name].filter((v) => typeof v === "string").join(" ").toLowerCase();
    if (!new RegExp(`(^|[^a-z0-9])${want.replace(/[^a-z0-9]/g, "")}([^a-z0-9]|$)`).test(hay)) continue;
    const home = await loadOwnedGigHome(db, managerUserId, String(record.id));
    if (home) out.push(home);
  }
  return out;
}

export type CreateGigInput = {
  managerUserId: string;
  workspaceId?: string | null;
  propertyId: string;
  roomLabel?: string | null;
  kind: GigKind;
  offeredCents: number;
  whenText?: string | null;
  /** A concrete start (UTC ISO) when the words named a day and a time; the accepted bid's proposed time. */
  whenStartIso?: string | null;
  source: "sms" | "portal";
  /** Idempotency: one posting per (manager, home, kind, price, day) unless a distinct key is given. */
  dedupeKey?: string;
};

export type CreateGigResult =
  | { ok: true; created: boolean; gigId: string; workOrderId: string; code: string; areaLabel: string | null }
  | { ok: false; status: number; error: string };

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function gigServiceTitle(kind: GigKind, roomLabel?: string | null): string {
  return `${GIG_KIND_LABEL[kind]}${roomLabel ? ` - ${roomLabel}` : ""}`;
}

export async function createGigPost(db: Db, input: CreateGigInput, deps: { now?: () => Date } = {}): Promise<CreateGigResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!Number.isInteger(input.offeredCents) || input.offeredCents < GIG_MIN_CENTS || input.offeredCents > GIG_MAX_CENTS) {
    return { ok: false, status: 400, error: "Enter a price between $5 and $2,000." };
  }
  const home = await loadOwnedGigHome(db, input.managerUserId, input.propertyId);
  if (!home) return { ok: false, status: 404, error: "That home is not one of yours." };

  const limited = await rateLimit(`gig-post:${input.managerUserId}`, GIG_POSTS_PER_MANAGER_PER_DAY, 24 * 60 * 60 * 1000);
  if (!limited.ok) return { ok: false, status: 429, error: "You have posted a lot of jobs today. Try again tomorrow." };

  const day = now.toISOString().slice(0, 10);
  const key = input.dedupeKey ?? `${input.managerUserId}|${home.id}|${input.roomLabel ?? ""}|${input.kind}|${input.offeredCents}|${input.whenText ?? ""}|${day}`;
  const workOrderId = `wo_gig_${hash(key)}`;
  // A repeat of the same posting the same day returns the earlier one (a retried confirm, a double tap).
  const { data: prior } = await db
    .from("gig_posts")
    .select("id, work_order_id, code, area_label")
    .eq("manager_user_id", input.managerUserId)
    .eq("work_order_id", workOrderId)
    .maybeSingle();
  if (prior) {
    const p = prior as { id: string; work_order_id: string; code: string; area_label: string | null };
    return { ok: true, created: false, gigId: p.id, workOrderId: p.work_order_id, code: p.code, areaLabel: p.area_label };
  }

  const title = gigServiceTitle(input.kind, input.roomLabel);
  const category = GIG_KIND_BOARD_CATEGORY[input.kind];
  const nowIso = now.toISOString();
  const row: DemoManagerWorkOrderRow = {
    id: workOrderId,
    propertyName: home.label,
    propertyAddress: home.address ? (home.zip && !home.address.includes(home.zip) ? `${home.address} ${home.zip}` : home.address) : undefined,
    unit: input.roomLabel?.trim() || "-",
    title,
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: [`PropLane Job: ${title}.`, input.whenText ? `When: ${input.whenText}.` : "", `Offered: $${(input.offeredCents / 100).toFixed(2)}.`].filter(Boolean).join(" "),
    scheduled: input.whenText?.trim() || "-",
    cost: "-",
    propertyId: home.id,
    assignedPropertyId: home.id,
    managerUserId: input.managerUserId,
    category: category as DemoManagerWorkOrderRow["category"],
    managerInitiated: true,
  };
  const { error: insertError } = await db.from("portal_work_order_records").insert({
    id: workOrderId,
    manager_user_id: input.managerUserId,
    property_id: home.id,
    resident_email: null,
    row_data: stampSmsTestProvenance({ ...(row as unknown as Record<string, unknown>), ...(input.whenStartIso ? { gigStartIso: input.whenStartIso } : {}) }),
    updated_at: nowIso,
  });
  if (insertError) return { ok: false, status: 500, error: "Could not save the job." };

  // The short code a vendor answers with. A collision (rare) draws again; the unique index is the arbiter.
  let gig: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 6 && !gig; attempt += 1) {
    const code = newGigCode();
    const { data, error } = await db
      .from("gig_posts")
      .insert({
        work_order_id: workOrderId,
        manager_user_id: input.managerUserId,
        workspace_id: input.workspaceId ?? null,
        kind: input.kind,
        offered_cents: input.offeredCents,
        window_text: input.whenText?.trim().slice(0, 80) || null,
        zip: home.zip,
        code,
        source: input.source,
        updated_at: nowIso,
      })
      .select("id, code")
      .maybeSingle();
    if (data) gig = data as { id: string; code: string };
    else if (error && error.code !== "23505") break;
  }
  if (!gig) {
    await db.from("portal_work_order_records").delete().eq("id", workOrderId).then(() => undefined, () => undefined);
    return { ok: false, status: 500, error: "Could not save the job." };
  }

  const published = await publishServiceToBoard(db as never, { userId: input.managerUserId, role: "manager", admin: false }, {
    workOrderId,
    budgetCents: input.offeredCents,
    category: category as DemoManagerWorkOrderRow["category"],
  });
  if (!published.ok) {
    // Saved but not public: the manager still has the service and can post it from Services.
    return { ok: false, status: published.status, error: published.error };
  }
  return { ok: true, created: true, gigId: gig.id, workOrderId, code: gig.code, areaLabel: null };
}
