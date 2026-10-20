import "server-only";

/**
 * The options a texter was quoted for a short stay and the one they picked, in `sms_stay_offers`
 * (service role only). `request_short_stay` books ONLY the option stored here, so neither the model nor
 * the text can change a room, a date or a price between the quote and the YES.
 *
 * Lifecycle: quoted -> prepared (they picked one and were asked to reply YES) -> booking (claimed by a
 * compare-and-swap, so a retried turn books once) -> booked. A newer quote supersedes the older.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const STAY_OFFER_TTL_MS = 2 * 60 * 60 * 1000;
/** Without a durable burst to tell turns apart, a pick must be at least this old before a YES counts. */
export const STAY_PICK_MIN_AGE_MS = 10_000;

export type StayOfferOption = {
  propertyId: string;
  roomId: string;
  homeName: string;
  roomLabel: string;
  nightly: number;
  nights: number;
  total: number;
  checkIn: string;
  checkOut: string;
  guests: number;
  listingUrl: string;
  /** "HH:MM" the texter said they would arrive ("arrive 1 pm"); stored on the stay, never acted on. */
  arrival?: string;
};

export type StayOfferRow = {
  id: string;
  managerUserId: string;
  phoneKey: string;
  options: StayOfferOption[];
  selectedIndex: number | null;
  preparedTurn: string | null;
  preparedAt: string | null;
  status: "quoted" | "prepared" | "booking" | "booked" | "superseded";
  blockId: string | null;
  expiresAt: string;
};

type Row = Record<string, unknown>;

function fromRow(row: Row): StayOfferRow {
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id),
    phoneKey: String(row.phone_key),
    options: Array.isArray(row.options) ? (row.options as StayOfferOption[]) : [],
    selectedIndex: typeof row.selected_index === "number" ? row.selected_index : null,
    preparedTurn: typeof row.prepared_turn === "string" ? row.prepared_turn : null,
    preparedAt: typeof row.prepared_at === "string" ? row.prepared_at : null,
    status: String(row.status) as StayOfferRow["status"],
    blockId: typeof row.block_id === "string" ? row.block_id : null,
    expiresAt: String(row.expires_at),
  };
}

export async function saveStayOffer(
  db: SupabaseClient,
  input: { managerUserId: string; phoneKey: string; options: StayOfferOption[]; now?: Date },
): Promise<StayOfferRow | null> {
  const now = input.now ?? new Date();
  await db
    .from("sms_stay_offers")
    .update({ status: "superseded", updated_at: now.toISOString() })
    .eq("manager_user_id", input.managerUserId)
    .eq("phone_key", input.phoneKey)
    .in("status", ["quoted", "prepared"]);
  const { data, error } = await db
    .from("sms_stay_offers")
    .insert({
      manager_user_id: input.managerUserId,
      phone_key: input.phoneKey,
      options: input.options,
      status: "quoted",
      expires_at: new Date(now.getTime() + STAY_OFFER_TTL_MS).toISOString(),
    })
    .select("*")
    .maybeSingle();
  return error || !data ? null : fromRow(data as Row);
}

/** The newest offer that can still be acted on (quoted or prepared, not expired). */
export async function loadLiveStayOffer(
  db: SupabaseClient,
  input: { managerUserId: string; phoneKey: string; now?: Date },
): Promise<StayOfferRow | null> {
  const now = input.now ?? new Date();
  const { data } = await db
    .from("sms_stay_offers")
    .select("*")
    .eq("manager_user_id", input.managerUserId)
    .eq("phone_key", input.phoneKey)
    .in("status", ["quoted", "prepared"])
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? fromRow(data as Row) : null;
}

export async function prepareStayOffer(
  db: SupabaseClient,
  input: { offerId: string; index: number; turn: string | null; now?: Date },
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from("sms_stay_offers")
    .update({ status: "prepared", selected_index: input.index, prepared_turn: input.turn, prepared_at: now, updated_at: now })
    .eq("id", input.offerId)
    .in("status", ["quoted", "prepared"])
    .select("id");
  return !error && (data ?? []).length === 1;
}

/** Compare-and-swap prepared -> booking. Exactly one caller wins. */
export async function claimPreparedStayOffer(db: SupabaseClient, offerId: string): Promise<boolean> {
  const { data, error } = await db
    .from("sms_stay_offers")
    .update({ status: "booking", updated_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("status", "prepared")
    .select("id");
  return !error && (data ?? []).length === 1;
}

export async function finishStayOffer(
  db: SupabaseClient,
  input: { offerId: string; status: "booked" | "prepared" | "superseded"; blockId?: string | null },
): Promise<void> {
  await db
    .from("sms_stay_offers")
    .update({ status: input.status, ...(input.blockId ? { block_id: input.blockId } : {}), updated_at: new Date().toISOString() })
    .eq("id", input.offerId);
}

/**
 * Was the pick made in an EARLIER turn than the one now reading a YES? A pick and its YES in the same
 * burst would let one text both choose and confirm.
 */
export function pickIsFromEarlierTurn(
  offer: Pick<StayOfferRow, "preparedTurn" | "preparedAt">,
  current: { turn: string | null; now?: Date },
): boolean {
  if (current.turn && offer.preparedTurn) return offer.preparedTurn !== current.turn;
  const at = offer.preparedAt ? Date.parse(offer.preparedAt) : NaN;
  return Number.isFinite(at) && (current.now ?? new Date()).getTime() - at >= STAY_PICK_MIN_AGE_MS;
}
