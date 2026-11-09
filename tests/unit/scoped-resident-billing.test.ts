// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
const state = vi.hoisted(() => ({ property: null as unknown }));
vi.mock("@/lib/rental-application/data", async (original) => ({ ...(await original<typeof import("@/lib/rental-application/data")>()), getPropertyById: () => state.property }));
vi.mock("@/lib/demo/demo-session", async (original) => ({ ...(await original<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => false }));
import { HOUSEHOLD_CHARGES_EVENT, HOUSEHOLD_CHARGES_SESSION_KEY, readHouseholdCharges, readRecurringRentProfilesForManager, mergeHouseholdChargesWithServer, mergeServerAuthoritativeRentProfiles, recordApprovedApplicationChargesScoped, seedDemoHouseholdCharges, mirrorApplicationHouseholdChargesAwait, readAuthoritativeBillingSnapshot } from "@/lib/household-charges";
const app = { id: "AXIS-OWN", managerUserId: "owner", email: "r@example.invalid", propertyId: "house", bucket: "approved", name: "R", application: { propertyId: "house", roomChoice1: "house::room", leaseStart: "2026-11-01", leaseEnd: "2027-10-31", leaseTerm: "12 months", rentalType: "standard" } } as DemoApplicantRow;
const base = { residentEmail: app.email, residentName: "R", residentUserId: null, propertyId: "house", propertyLabel: "House", managerUserId: "foreign", status: "pending", createdAt: "2026-01-01", kind: "security_deposit", title: "Deposit", amountLabel: "$5", balanceLabel: "$5", blocksLeaseUntilPaid: false } as HouseholdCharge;
const profile = { id: "foreign-profile", residentEmail: app.email, residentName: "R", residentUserId: null, propertyId: "house", propertyLabel: "House", roomLabel: "Room", managerUserId: "foreign", monthlyRent: 1000, active: true, updatedAt: "2026-01-01" } as RecurringRentProfile;
beforeEach(() => {
  setPortalSessionViewer(null);
  sessionStorage.clear(); localStorage.clear();
  const submission = createDefaultListingSubmission(); submission.rooms = [{ ...submission.rooms[0]!, id: "room", name: "Room", monthlyRent: 1000 }];
  state.property = { id: "house", title: "House", managerUserId: "owner", listingSubmission: submission };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, confirmedChargeIds: [], confirmedProfileIds: [] }), { status: 200 })));
});
it("keeps foreign and distinct same-owner application rows unchanged and never mirrors during generation", () => {
  const foreign = { ...base, id: "foreign-charge", applicationId: "AXIS-FOREIGN" };
  const sibling = { ...base, id: "sibling-charge", managerUserId: "owner", applicationId: "AXIS-OTHER" };
  seedDemoHouseholdCharges([foreign, sibling], [profile]);
  const listener = vi.fn(); window.addEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
  const result = recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true });
  expect(result.ok).toBe(true);
  expect(readHouseholdCharges().some((row) => row.applicationId === app.id)).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(result.stage?.commit()).toBe(true);
  expect(readHouseholdCharges().some((row) => row.applicationId === app.id && row.managerUserId === "owner")).toBe(true);
  expect(readHouseholdCharges().find((row) => row.id === foreign.id)).toEqual(foreign);
  expect(readHouseholdCharges().find((row) => row.id === sibling.id)).toEqual(sibling);
  expect(readRecurringRentProfilesForManager("foreign")).toContainEqual(profile);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
});
it("restores arrays and session on a thrown generator with an empty selected scope", () => {
  const foreign = { ...base, id: "foreign-charge", applicationId: "AXIS-FOREIGN" };
  seedDemoHouseholdCharges([foreign], [profile]);
  const beforeSession = sessionStorage.getItem(HOUSEHOLD_CHARGES_SESSION_KEY);
  state.property = { id: "house", managerUserId: "owner", get listingSubmission() { throw new Error("fixture error"); } };
  const listener = vi.fn(); window.addEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
  expect(() => recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true })).toThrow("fixture error");
  expect(readHouseholdCharges()).toEqual([foreign]);
  expect(sessionStorage.getItem(HOUSEHOLD_CHARGES_SESSION_KEY)).toBe(beforeSession);
  expect(listener).not.toHaveBeenCalled(); expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
});
it("never sends foreign rows in scoped confirmation", async () => {
  seedDemoHouseholdCharges([{ ...base, id: "foreign-charge", applicationId: "AXIS-OWN" }], [profile]);
  expect(await mirrorApplicationHouseholdChargesAwait(app)).toBe(false);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it("keeps foreign owner rows distinct in hydration and server merges", () => {
  const owned = { ...base, id: "owned", managerUserId: "owner", applicationId: "AXIS-OWN" };
  const foreign = { ...owned, id: "foreign", managerUserId: "foreign" };
  const ownProfile = { ...profile, id: "owned-profile", managerUserId: "owner" };
  seedDemoHouseholdCharges([owned, foreign], [ownProfile, profile]);
  expect(readHouseholdCharges()).toHaveLength(2);
  expect(readRecurringRentProfilesForManager("owner")).toHaveLength(1);
  expect(readRecurringRentProfilesForManager("foreign")).toHaveLength(1);
  expect(mergeHouseholdChargesWithServer([owned], [foreign]).merged).toHaveLength(2);
  expect(mergeServerAuthoritativeRentProfiles([ownProfile], [profile])).toHaveLength(2);
});

it("reads a complete server snapshot without publishing and refuses an incomplete read", async () => {
  seedDemoHouseholdCharges([], []);
  const serverCharge = { ...base, id: "server-row", managerUserId: "owner", applicationId: app.id };
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ charges: [serverCharge], rentProfiles: [] }), { status: 200 }));
  const listener = vi.fn(); window.addEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
  expect((await readAuthoritativeBillingSnapshot()).charges).toEqual([serverCharge]);
  expect(readHouseholdCharges()).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ charges: [], rentProfiles: [], chargesTruncated: true }), { status: 200 }));
  await expect(readAuthoritativeBillingSnapshot()).rejects.toThrow();
  window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, listener);
});

it("reuses confirmed server rows after a lost acknowledgement without duplicating ids", () => {
  seedDemoHouseholdCharges([], []);
  const first = recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true }, { charges: [], rentProfiles: [] });
  expect(first.stage).toBeDefined();
  expect(readHouseholdCharges()).toEqual([]);
  const retry = recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true }, { charges: first.stage!.charges, rentProfiles: first.stage!.profiles });
  expect(retry.stage!.charges.map((row) => row.id).sort()).toEqual(first.stage!.charges.map((row) => row.id).sort());
  expect(retry.stage!.commit()).toBe(true);
});

it("refuses a stale pending snapshot over a locally paid charge", () => {
  const paid = { ...base, id: "paid", managerUserId: "owner", applicationId: app.id, status: "paid" } as HouseholdCharge;
  seedDemoHouseholdCharges([paid], []);
  const stale = { ...paid, status: "pending" } as HouseholdCharge;
  expect(recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true }, { charges: [stale], rentProfiles: [] }).ok).toBe(false);
  expect(readHouseholdCharges()).toContainEqual(paid);
});

it("refuses a pending manager override newer than the server", () => {
  const edited = { ...base, id: "edited", managerUserId: "owner", applicationId: app.id, manualAmountOverrideAt: "2026-11-08T12:00:00.000Z" };
  seedDemoHouseholdCharges([edited], []);
  expect(recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true }, { charges: [{ ...edited, manualAmountOverrideAt: "2026-11-07T12:00:00.000Z" }], rentProfiles: [] }).ok).toBe(false);
  expect(readHouseholdCharges()).toContainEqual(edited);
});

it("does not publish a staged write after the viewer changes during acknowledgement", async () => {
  seedDemoHouseholdCharges([], []);
  setPortalSessionViewer("first");
  const staged = recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true });
  expect(staged.stage).toBeDefined();
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const ack = mirrorApplicationHouseholdChargesAwait(app, undefined, staged.stage);
  setPortalSessionViewer("second");
  finish(new Response(JSON.stringify({ ok: true, confirmedChargeIds: staged.stage!.charges.map((row) => row.id), confirmedProfileIds: staged.stage!.profiles.map((row) => row.id) }), { status: 200 }));
  await ack;
  expect(staged.stage!.commit()).toBe(false);
  expect(readHouseholdCharges()).toEqual([]);
});

it("accepts matching paid evidence with additional server metadata", () => {
  const paid = { ...base, id: "paid", managerUserId: "owner", applicationId: app.id, status: "paid" } as HouseholdCharge;
  seedDemoHouseholdCharges([paid], []);
  const server = { ...paid, residentChargeMessages: [{ id: "message", body: "test", sentAt: "now", residentUserId: "resident" }] };
  expect(recordApprovedApplicationChargesScoped(app, undefined, true, { leaseExecuted: true }, { charges: [server], rentProfiles: [] }).ok).toBe(true);
});
