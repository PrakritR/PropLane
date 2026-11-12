import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createDefaultListingSubmission, emptyRoom, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { catalogPropertyFromRow } from "@/lib/manager-sms-commands/catalog.server";
import type { CatalogProperty } from "@/lib/manager-sms-commands/resolve-target";
import { makeCommandDb, type Row } from "./command-fake-db";

export const OWNER = "owner-1";
export const STAFF = "staff-1";
export const WS = "ws-1";
export const STAFF_PHONE = "+12065550142";
export const HEIC = readFileSync(path.join(__dirname, "../fixtures/heic/room-640x480.heic"));

export async function jpegBytes(width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height * 3, 120), { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
}

export function propertyRow(id: string, address: string, roomCount: number, extra: { status?: string } = {}): Row {
  const sub = createDefaultListingSubmission();
  sub.address = address;
  sub.buildingName = address;
  sub.rooms = Array.from({ length: roomCount }, (_, i) => ({ ...emptyRoom(i), id: `${id}-room-${i + 1}`, monthlyRent: 900 + i * 10 }));
  const submission = normalizeManagerListingSubmissionV1(sub);
  return {
    id, manager_user_id: OWNER, workspace_id: WS, status: extra.status ?? "live",
    row_data: { id, submission }, property_data: { id, address, buildingName: address, listingSubmission: submission },
  };
}

export function world(extraTables: Record<string, Row[]> = {}) {
  const rows = [
    propertyRow("prop-5259", "5259 Brooklyn Ave NE, Seattle, WA", 4),
    propertyRow("prop-5257", "5257 Brooklyn Ave NE, Seattle, WA", 4),
    propertyRow("prop-4709a", "4709A 8th Ave NE, Seattle, WA", 9),
  ];
  const db = makeCommandDb({ manager_property_records: rows, ...extraTables }, { unique: { audit_log: ["dedupe_key"], sms_reply_handles: ["staff_phone_key", "handle"] } });
  const catalog: CatalogProperty[] = rows
    .map((row) => catalogPropertyFromRow(row as never, { workspaceId: WS, ownerUserId: OWNER }))
    .filter((p): p is CatalogProperty => Boolean(p));
  const ctx = {
    landlordId: OWNER, userId: STAFF, email: "staff@example.test", roles: ["manager"], isAdmin: false, db,
    workspace: { id: WS, name: "Ambika", isDefault: false, narrowing: true, propertyIds: rows.map((r) => String(r.id)) },
  } as never;
  return { db, catalog, ctx, rows };
}

export function roomPhotos(db: ReturnType<typeof makeCommandDb>, propertyId: string, roomIndex: number): string[] {
  const row = db.tables.manager_property_records!.find((r) => r.id === propertyId)!;
  const sub = (row.property_data as { listingSubmission: { rooms: Array<{ photoDataUrls: string[] }> } }).listingSubmission;
  return sub.rooms[roomIndex]!.photoDataUrls;
}

export function housePhotos(db: ReturnType<typeof makeCommandDb>, propertyId: string): string[] {
  const row = db.tables.manager_property_records!.find((r) => r.id === propertyId)!;
  return (row.property_data as { listingSubmission: { housePhotoDataUrls: string[] } }).listingSubmission.housePhotoDataUrls;
}
