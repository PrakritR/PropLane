// @vitest-environment jsdom
/**
 * Render regression + evidence harness for resident "My home".
 *
 * The housemate rows are produced by the REAL server loader
 * (`loadResidentMoveInForEmail`), so what the browser is handed is what the
 * redaction actually allows: everything private by default, and only the fields
 * a peer independently opted into. The rendered markup is written to
 * EVIDENCE_DIR (when set) so it can be screenshotted in a browser — same
 * convention as `evidence-lease-template-ui.test.tsx`.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";
import { DEFAULT_HOUSEMATE_SHARING, type HousemateSharing } from "@/lib/resident-housemate-sharing";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";

let preferences: HousemateSharing | null = null;
let prefError = false;
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "self-id", ready: true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/resident/my-home/housemates" }));

const listing = {
  ...createDefaultListingSubmission(),
  listingPlaceCategoryId: "private_room",
  buildingName: "Brooklyn House",
  address: "412 Vanderbilt Ave, Brooklyn NY",
  rooms: [
    { ...emptyRoom(0), id: "room-1", name: "Room 1" },
    { ...emptyRoom(1), id: "room-2", name: "Room 2" },
  ],
  generalHouseInfo: "Trash goes out Tuesday night. The laundry room is in the basement.",
  houseRulesText: "Quiet hours are 10pm-7am. No smoking anywhere inside.",
  amenitiesText: "In-unit laundry\nDishwasher\nBackyard",
};
const application = (email: string, name: string, room: string, roomChoice: string) => ({
  id: email, resident_email: email, manager_user_id: "manager", property_id: "home", assigned_property_id: "home",
  row_data: { id: email, email, name, bucket: "approved", propertyId: "home", assignedPropertyId: "home", stage: "Approved",
    assignedRoomChoice: roomChoice, manualResidentDetails: { roomNumber: room } },
});
const jsonPath = (row: Record<string, unknown>, key: string): unknown => {
  if (!key.includes("->")) return row[key];
  const [base, ...rest] = key.replace(/->>/g, "->").split("->");
  let value: unknown = row[base!];
  for (const segment of rest) value = (value as Record<string, unknown> | undefined)?.[segment];
  return value;
};
const db = { from: (table: string) => {
  const data: Record<string, unknown>[] = table === "manager_application_records"
    ? [application("self@example.test", "Self", "Room 1", "home::room-1"), application("peer@example.test", "Alex Chen", "Room 2", "home::room-2")]
    : table === "manager_property_records"
      ? [{ id: "home", property_data: { id: "home", title: "Brooklyn House", address: "412 Vanderbilt Ave, Brooklyn NY", listingSubmission: listing }, row_data: {} }]
      : table === "profiles"
        ? [{ id: "peer-id", email: "peer@example.test", full_name: "Alex Chen", phone: "2065550100" }]
        : preferences ? [{ user_id: "peer-id", preferences }] : [];
  let values = data;
  const result = () => ({ data: values, error: table === "resident_housemate_sharing" && prefError ? { message: "unavailable" } : null });
  const q = { select: () => q, order: () => q, range: () => q,
    eq: (key: string, value: string) => { values = values.filter(row => jsonPath(row, key) === value); return q; },
    in: (key: string, allowed: string[]) => { values = values.filter(row => allowed.includes(String(row[key]))); return q; },
    maybeSingle: async () => ({ ...result(), data: values[0] ?? null }),
    then: (resolve: (r: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve) };
  return q;
} };

import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";


beforeEach(() => {
  preferences = null; prefError = false;
    // The demo sandbox is derived from the pathname; a resident portal path keeps this a real session.
  window.history.replaceState({}, "", "/resident/my-home/housemates");
  vi.stubGlobal("fetch", vi.fn(async () => { return new Response(JSON.stringify({ preferences: preferences ?? DEFAULT_HOUSEMATE_SHARING }), { status: 200, headers: { "content-type": "application/json" } }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("housemates are private by default and reveal only what a peer opted into", async () => {
  // Nothing shared: the peer's name, email, phone and room are all withheld.
  const privateView = await loadResidentMoveInForEmail("self@example.test");
  expect(privateView?.housemates).toEqual([
    expect.objectContaining({ name: "Housemate", email: "", phone: null, roomLabel: "" }),
  ]);
  render(<ResidentMoveInShell basePath="/resident" email="self@example.test" resolved={privateView} activeTab="housemates" />);
  // The resident's own sharing panel loads its saved choices — all off by default.
  await waitFor(() => expect(screen.queryByText("Loading your choices…")).toBeNull());
  for (const label of ["My name", "My room", "My email address", "My phone number"]) {
    expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(false);
  }
  expect(document.body.textContent).not.toContain("Alex Chen");
  expect(document.body.textContent).not.toContain("peer@example.test");
  expect(document.body.textContent).toContain("Contact details not shared");
  writeEvidenceSurface("my-home-01-housemates-private", "Resident · My home › Housemates — every peer detail is private by default; each resident opts in independently from the same panel.");

  // The peer opts into name + room + email; the phone stays withheld.
  cleanup();
  preferences = { ...DEFAULT_HOUSEMATE_SHARING, shareName: true, shareRoom: true, shareEmail: true };
  const sharedView = await loadResidentMoveInForEmail("self@example.test");
  expect(sharedView?.housemates[0]).toMatchObject({ name: "Alex Chen", email: "peer@example.test", phone: null, roomLabel: "Room 2" });
  render(<ResidentMoveInShell basePath="/resident" email="self@example.test" resolved={sharedView} activeTab="housemates" />);
  await waitFor(() => expect((screen.getByRole("checkbox", { name: "My name" }) as HTMLInputElement).checked).toBe(true));
  expect((screen.getByRole("checkbox", { name: "My phone number" }) as HTMLInputElement).checked).toBe(false);
  expect(document.body.textContent).toContain("Phone not shared");
  writeEvidenceSurface("my-home-02-housemates-opted-in", "Resident · My home › Housemates — sharing is on for name/room/email and off for phone, and the housemate row below reflects exactly that: Alex Chen · Room 2 · email, “Phone not shared”.");

  // Revocation is honored on the next read, and only current residents are listed.
  cleanup();
  preferences = DEFAULT_HOUSEMATE_SHARING;
  const revoked = await loadResidentMoveInForEmail("self@example.test");
  expect(revoked?.housemates[0]).toMatchObject({ name: "Housemate", email: "", roomLabel: "" });
});

it("house info and rules come from the listing the manager published", async () => {
  const resolved = await loadResidentMoveInForEmail("self@example.test");
  render(<ResidentMoveInShell basePath="/resident" email="self@example.test" resolved={resolved} activeTab="info" />);
  expect(document.body.textContent).toContain("Trash goes out Tuesday night.");
  expect(document.body.textContent).toContain("Quiet hours are 10pm-7am.");
  writeEvidenceSurface("my-home-03-house-info", "Resident · My home › House info — house info and rules read straight from the manager's listing.");
});

it("a preferences read that fails discloses nothing", async () => {
  preferences = { shareName: true, shareRoom: true, shareEmail: true, sharePhone: true };
  prefError = true;
  const resolved = await loadResidentMoveInForEmail("self@example.test");
  expect(resolved?.housemates[0]).toMatchObject({ name: "Housemate", email: "", phone: null, roomLabel: "" });
});
