/**
 * Listing Message, pure half (design-1112 §3.2). A signed-out visitor sends a message about a home (or one room of it)
 * with only a phone number proved by a text code: no account, no email. These are the request shape and its limits.
 */
export const LISTING_MESSAGE_BODY_MAX = 1000;
export const LISTING_MESSAGE_NAME_MAX = 80;

export type ListingMessageAction = "send_code" | "verify_send";

export type ListingMessageRequest = {
  action: ListingMessageAction;
  propertyId: string;
  roomId: string | null;
  phone: string;
  name: string | null;
  body: string;
  otp: string;
};

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "";
}

/** The request, or the one error to say. Nothing here reads a database; ids are only shape-checked. */
export function parseListingMessageRequest(raw: unknown): { ok: true; value: ListingMessageRequest } | { ok: false; error: string } {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) return { ok: false, error: "Unsupported request." };
  const action = r.action === "send_code" || r.action === "verify_send" ? r.action : null;
  if (!action) return { ok: false, error: "Unsupported request." };
  const propertyId = text(r.propertyId, 200);
  if (!ID.test(propertyId)) return { ok: false, error: "This listing is not available." };
  const roomRaw = text(r.roomId, 200);
  if (roomRaw && !ID.test(roomRaw)) return { ok: false, error: "That room is not on this listing." };
  const body = text(r.body, LISTING_MESSAGE_BODY_MAX);
  if (!body) return { ok: false, error: "Write a message first." };
  return {
    ok: true,
    value: {
      action,
      propertyId,
      roomId: roomRaw || null,
      phone: text(r.phone, 40),
      name: text(r.name, LISTING_MESSAGE_NAME_MAX) || null,
      body,
      otp: text(r.otp, 12),
    },
  };
}
