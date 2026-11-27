/**
 * A listing's public "Text us": a PropLane-managed (is_service) workspace's own registered number (resolveServiceLine, the
 * decision the SMS side sends from); every other listing keeps the configured PropLane line (the route returns phone: null).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const loaded = vi.hoisted(() => ({ value: { ok: true, listing: { workspaceId: "ws-1", ownerUserId: "o1", propertyId: "p1" } } as unknown }));
vi.mock("@/lib/listing-message/listing.server", () => ({ loadMessageListing: vi.fn(async () => loaded.value) }));
vi.mock("@/lib/one-number/entry-codes.server", () => ({ createEntryCode: vi.fn(), listEntryCodes: vi.fn() }));
const managed = vi.hoisted(() => ({ is: true as boolean | null }));
const line = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/one-number/service-line.server", () => ({
  isServiceWorkspace: vi.fn(async () => managed.is),
  resolveServiceLine: vi.fn(async () => line.value),
}));

import { resolveManagedListingTextPhone } from "@/lib/listing-message/text-us-code.server";

const db = {} as never;

beforeEach(() => {
  managed.is = true;
  loaded.value = { ok: true, listing: { workspaceId: "ws-1", ownerUserId: "o1", propertyId: "p1" } };
  line.value = { ok: true, kind: "owner_number", source: "workspace", phoneNumber: "+18146793694" };
});

describe("resolveManagedListingTextPhone", () => {
  it("returns a managed workspace's own registered number (814 for Ambika's houses)", async () => {
    expect(await resolveManagedListingTextPhone(db, "p1")).toBe("+18146793694");
  });
  it("returns null for a self-serve house, so the PropLane line stands", async () => {
    managed.is = false;
    expect(await resolveManagedListingTextPhone(db, "p1")).toBeNull();
  });
  it("returns null when the managed workspace has only the PropLane line or the read is unreadable", async () => {
    line.value = { ok: true, kind: "owner_number", source: "service_owner", phoneNumber: "+12065550100" };
    expect(await resolveManagedListingTextPhone(db, "p1")).toBeNull();
    line.value = { ok: false, reason: "unreadable" };
    expect(await resolveManagedListingTextPhone(db, "p1")).toBeNull();
    managed.is = null;
    expect(await resolveManagedListingTextPhone(db, "p1")).toBeNull();
  });
  it("returns null for a listing that is not live", async () => {
    loaded.value = { ok: false, reason: "not_found" };
    expect(await resolveManagedListingTextPhone(db, "p1")).toBeNull();
  });
});
