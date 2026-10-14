/**
 * Quick apply: a signed-in resident submits a SOLO application from the answers their last one holds.
 * The shared write (validation, fee guard, linking, notices) is mocked here and asserted on; its own
 * behaviour is pinned by the manager-applications route tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  basis: vi.fn(),
  property: vi.fn(),
  onListing: vi.fn(),
  fee: vi.fn(),
  prepare: vi.fn(),
  persist: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("@/lib/rental-application/resident-application-autofill.server", () => ({
  loadResidentApplicationAutofillBasis: mocks.basis,
}));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  // The real memoizer hands back a loader; here the listing read IS the mock.
  memoizeEffectiveApplicationProperty: () => mocks.property,
  validateResidentApplicationRowForPersistence: mocks.validate,
}));
vi.mock("@/lib/rental-application/duplicate-application.server", () => ({
  findResidentApplicationsForListing: mocks.onListing,
}));
vi.mock("@/lib/rental-application/application-fee-submit-guard.server", () => ({
  authorizeApplicationFeeSubmission: mocks.fee,
}));
vi.mock("@/lib/rental-application/signed-in-application-write.server", () => ({
  prepareResidentSelfWrite: mocks.prepare,
  persistApplicationWrite: mocks.persist,
}));

import { carryCustomFieldAnswers, runQuickApply } from "@/lib/rental-application/quick-apply.server";

const PROFILE = { fullLegalName: "Dana Resident", phone: "2065550100", currentStreet: "1 Main St" };
const CUSTOM_PET = { id: "c1", key: "pet_name", label: "Pet name", type: "text", required: true, options: [], section: "household" };

function listing(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    property: {
      id: "prop-1",
      title: "5257 Brooklyn Ave",
      listingSubmission: {
        v: 1,
        rooms: [{ id: "r1", name: "Room 1" }, { id: "r2", name: "Room 2" }],
        allowedLeaseTerms: ["Long-term"],
        customApplicationFields: [],
        ...overrides,
      },
    },
  };
}

const db = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { manager_user_id: "mgr-1", status: "live" }, error: null }) }),
    }),
  }),
} as unknown as SupabaseClient;

const ctx = { user: { id: "u1", email: "dana@example.com" }, role: "resident", email: "dana@example.com", leadSource: null };
const input = {
  propertyId: "prop-1",
  roomId: "r1",
  leaseStart: "2026-11-01",
  confirmCurrent: true,
  consentTruth: true,
  signature: "Dana Resident",
};
const nothingOnListing = () => ({ byRoom: new Map(), draftsByRoom: new Map() });

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.basis.mockResolvedValue({ profile: PROFILE, customFieldAnswers: [] });
  mocks.property.mockResolvedValue(listing());
  mocks.onListing.mockResolvedValue(nothingOnListing());
  mocks.fee.mockResolvedValue({ ok: true });
  mocks.validate.mockResolvedValue({ ok: true });
  mocks.prepare.mockImplementation(async (_db, _user, { row }) => ({ ok: true, row, authorizedWriteRecord: null }));
  mocks.persist.mockImplementation(async (_db, { row }) => ({ ok: true, row, linkedForms: [] }));
});

describe("quick apply", () => {
  it("sends a resident with no saved application to the wizard", async () => {
    mocks.basis.mockResolvedValue(null);
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ needsWizard: true, reason: "no_profile" });
    expect((out.body as { href: string }).href).toContain("propertyId=prop-1");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("needs the sheet's confirmation and signature", async () => {
    expect((await runQuickApply(db, ctx, { ...input, confirmCurrent: false })).status).toBe(400);
    expect((await runQuickApply(db, ctx, { ...input, signature: "  " })).status).toBe(400);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("returns needsWizard with the keys when a required custom question has no saved answer", async () => {
    mocks.property.mockResolvedValue(listing({ customApplicationFields: [CUSTOM_PET], applicationConfigMode: "custom" }));
    const out = await runQuickApply(db, ctx, input);
    expect(out.body).toMatchObject({ needsWizard: true, reason: "missing_answers" });
    expect((out.body as { missing: string[] }).missing).toEqual(["custom:pet_name"]);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("answers a custom question only from an earlier answer with the same key AND type", () => {
    const fields = [CUSTOM_PET] as never;
    expect(carryCustomFieldAnswers(fields, [{ key: "pet_name", label: "Pet", type: "text", value: "Rex" }])).toHaveLength(1);
    expect(carryCustomFieldAnswers(fields, [{ key: "pet_name", label: "Pet", type: "number", value: "3" }])).toEqual([]);
    expect(carryCustomFieldAnswers(fields, [{ key: "other", label: "Pet", type: "text", value: "Rex" }])).toEqual([]);
  });

  it("refuses a duplicate of the same room with a 409", async () => {
    mocks.onListing.mockResolvedValue({ byRoom: new Map([["prop-1::r1", { id: "PROPLANE-OLD1", row: {} }]]), draftsByRoom: new Map() });
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "You already applied to this room." });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("saves a draft at the last step and answers needsPayment when a fee is owed", async () => {
    mocks.fee.mockResolvedValue({ ok: false, status: 409, error: "Pay this application's fee before submitting.", reason: "unpaid" });
    const out = await runQuickApply(db, ctx, input);
    expect(out.body).toMatchObject({ needsPayment: true });
    const saved = mocks.prepare.mock.calls[0]![2].row;
    expect(saved.stage).toBe("In progress");
    expect(saved.application.wizardStep).toBe(7);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it("resumes the resident's live draft for the room instead of minting a second one", async () => {
    mocks.onListing.mockResolvedValue({
      byRoom: new Map(),
      draftsByRoom: new Map([["prop-1::r1", { id: "PROPLANE-DRAFT1", row: {} }]]),
    });
    mocks.fee.mockResolvedValue({ ok: false, status: 409, error: "Pay this application's fee before submitting.", reason: "unpaid" });
    const out = await runQuickApply(db, ctx, input);
    expect(out.body).toMatchObject({ needsPayment: true });
    // The fee claim is keyed on the application id, so the row that collects the fee has to be the
    // draft that already exists for this room — not a new id beside it.
    expect(mocks.fee.mock.calls[0]![1].id).toBe("PROPLANE-DRAFT1");
    expect(mocks.prepare.mock.calls[0]![2]).toMatchObject({ requestedRowId: "PROPLANE-DRAFT1" });
    expect(mocks.prepare.mock.calls[0]![2].row.id).toBe("PROPLANE-DRAFT1");
  });

  it("records the truthfulness attestation only from the applicant's own tick", async () => {
    await runQuickApply(db, ctx, input);
    expect(mocks.prepare.mock.calls[0]![2].row.application.consentTruth).toBe(true);

    // Not ticked: the listing asks and requires it, so the full application opens instead of the
    // server acknowledging an attestation on their behalf.
    mocks.prepare.mockClear();
    const unticked = await runQuickApply(db, ctx, { ...input, consentTruth: false });
    expect(unticked.body).toMatchObject({ needsWizard: true, reason: "missing_answers", missing: ["consentTruth"] });
    expect(mocks.prepare).not.toHaveBeenCalled();

    // A listing that does not ask the question records nothing, whatever the request says.
    mocks.property.mockResolvedValue(listing({ disabledStandardApplicationKeys: ["consent-truthfulness-certification"] }));
    await runQuickApply(db, ctx, { ...input, consentTruth: true });
    expect(mocks.prepare.mock.calls[0]![2].row.application.consentTruth).toBe(false);
  });

  it("does not turn an unverifiable fee into a draft", async () => {
    mocks.fee.mockResolvedValue({ ok: false, status: 500, error: "Could not verify the application fee. Try again.", reason: "unverifiable" });
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(500);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("a 409 the fee guard could not verify is a refusal, never an invoice", async () => {
    mocks.fee.mockResolvedValue({ ok: false, status: 409, error: "Application fee source cannot be verified.", reason: "unverifiable" });
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "Application fee source cannot be verified." });
    expect(out.body).not.toHaveProperty("needsPayment");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("a dry run with no room picked is judged on a room the resident has NOT already applied to", async () => {
    mocks.onListing.mockResolvedValue({ byRoom: new Map([["prop-1::r1", { id: "PROPLANE-OLD1", row: {} }]]), draftsByRoom: new Map() });
    const out = await runQuickApply(db, ctx, { propertyId: "prop-1", dryRun: true });
    // The rooms already applied to ride along, so the card answers every later room pick from this
    // one reply instead of spending another dry run on each.
    expect(out.body).toEqual({ ready: true, appliedRooms: { "prop-1::r1": "PROPLANE-OLD1" } });
    expect(mocks.validate.mock.calls[0]![1].application.roomChoice1).toBe("prop-1::r2");

    // Every room taken: only then is the verdict "you already applied".
    mocks.onListing.mockResolvedValue({
      byRoom: new Map([
        ["prop-1::r1", { id: "PROPLANE-OLD1", row: {} }],
        ["prop-1::r2", { id: "PROPLANE-OLD2", row: {} }],
      ]),
      draftsByRoom: new Map(),
    });
    const taken = await runQuickApply(db, ctx, { propertyId: "prop-1", dryRun: true });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ existingApplicationId: "PROPLANE-OLD1" });
  });

  it("applies for the whole place on an entire-home listing, never one of its bedrooms", async () => {
    mocks.property.mockResolvedValue(listing({ listingPlaceCategoryId: "entire_home" }));
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(200);
    expect(mocks.prepare.mock.calls[0]![2].row.application.roomChoice1).toBe("prop-1");

    // A room id in the request cannot turn a whole-home application into a bedroom application, and the
    // duplicate guard is the property itself.
    mocks.prepare.mockClear();
    mocks.onListing.mockResolvedValue({ byRoom: new Map([["prop-1", { id: "PROPLANE-OLD1", row: {} }]]), draftsByRoom: new Map() });
    const dup = await runQuickApply(db, ctx, { ...input, roomId: "r2" });
    expect(dup.status).toBe(409);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("a dry run runs the shared validator, so the button never promises an apply the write refuses", async () => {
    mocks.validate.mockResolvedValue({ ok: false, status: 422, error: "x", fieldErrors: { idPhotoFront: "required" } });
    const out = await runQuickApply(db, ctx, { propertyId: "prop-1", dryRun: true });
    expect(out.body).toMatchObject({ needsWizard: true, reason: "missing_answers", missing: ["idPhotoFront"] });
    expect(mocks.persist).not.toHaveBeenCalled();

    mocks.validate.mockResolvedValue({ ok: true });
    expect((await runQuickApply(db, ctx, { propertyId: "prop-1", dryRun: true })).body).toEqual({ ready: true });
    // The sheet's own fields stand in as filled: a dry run is never refused for the move-in or the consent.
    const probe = mocks.validate.mock.calls[0]![1];
    expect(probe.application.leaseStart).toBeTruthy();
    expect(probe.application.consentCredit).toBe(true);
  });

  it("maps a validator refusal to needsWizard with the failing keys", async () => {
    mocks.prepare.mockResolvedValue({ ok: false, status: 422, body: { error: "x", fieldErrors: { currentCity: "required" } } });
    const out = await runQuickApply(db, ctx, input);
    expect(out.body).toMatchObject({ needsWizard: true, missing: ["currentCity"] });
  });

  it("submits a solo, pinned application through the shared write on the happy path", async () => {
    mocks.basis.mockResolvedValue({
      profile: { ...PROFILE, groupId: "AXISGRP-OLDGROUP1", applyingAsGroup: "yes", groupRole: "member", groupSize: "3", bundleId: "b1" },
      customFieldAnswers: [],
    });
    const out = await runQuickApply(db, ctx, input);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true });
    const { applicationId, href } = out.body as { applicationId: string; href: string };
    expect(href).toBe(`/resident/applications/pending/${applicationId}`);

    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const row = mocks.prepare.mock.calls[0]![2].row;
    expect(mocks.persist.mock.calls[0]![1]).toMatchObject({ residentSelfWrite: true, user: ctx.user });
    expect(row).toMatchObject({ bucket: "pending", stage: "Submitted", residentUserId: "u1", propertyId: "prop-1", quickApplied: true });
    const app = row.application;
    expect(app.roomChoice1).toBe("prop-1::r1");
    expect(app).toMatchObject({
      leaseStart: "2026-11-01",
      rentalType: "standard",
      applyingAsGroup: null,
      groupRole: null,
      groupSize: "",
      groupId: "",
      groupLeaderAppId: "",
      bundleId: "",
      consentTruth: true,
      digitalSignature: "Dana Resident",
      fullLegalName: "Dana Resident",
    });
    expect("applicationTemplateId" in app).toBe(true);
  });
});
