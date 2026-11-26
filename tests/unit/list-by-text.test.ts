// "HEY I WANT TO LIST MY PROPERTY", by text only: the stall, photos by MMS, PUBLISH through the wizard's publish core, and
// one end-to-end flow (intent -> sign-up -> code -> address -> rooms/rent -> date -> photos -> PUBLISH -> live record).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";
import { linksFakeDb } from "../helpers/links-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: vi.fn() }));
vi.mock("@/lib/one-number/signup/sign-in-link.server", () => ({ mintPhoneSignInLink: vi.fn(async () => "https://proplane.ai/auth/confirm?token_hash=H&type=magiclink") }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/listing-channels/sync.server", () => ({ scheduleListingChannelSync: vi.fn() }));
vi.mock("@/lib/listing-service-fee-write.server", () => ({ reconcileListingServiceFeeOnWrite: vi.fn(async (_db: unknown, i: { rowData: unknown; propertyData: unknown }) => ({ rowData: i.rowData, propertyData: i.propertyData })) }));
vi.mock("@/lib/listing-application-form-write.server", () => ({ reconcileListingApplicationFormOnWrite: vi.fn(async (_db: unknown, i: { rowData: unknown; propertyData: unknown }) => ({ rowData: i.rowData, propertyData: i.propertyData })) }));
const quota = vi.hoisted(() => ({ verdict: { ok: true } as Record<string, unknown>, calls: [] as unknown[] }));
vi.mock("@/lib/manager-property-quota.server", () => ({
  assertManagerPropertyListingQuota: vi.fn(async (_db: unknown, params: unknown) => {
    quota.calls.push(params);
    return quota.verdict;
  }),
}));
const handleLineMemberText = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({ onLine: true }));
const upload = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/listing-draft-agent.server", () => ({
  uploadListingPhotoBytes: vi.fn(async (_db: unknown, userId: string) => `https://x.supabase.co/storage/v1/object/public/listing-photos/${userId}/p${++upload.n}.jpg`),
}));

import { publishOwnedDraftListing, missingForPublish } from "@/lib/property-records/publish-listing.server";
import { saveTextListingDraft } from "@/lib/one-number/onboarding/house-draft.server";
import { FIRST_HOME_COPY, handleFirstHomeText, handleFirstHomeTextSafely, hasLiveFirstHomeSession, startFirstHomeWalkthrough } from "@/lib/one-number/signup/first-home.server";
import { handleSmsSignupText, type SignupDeps } from "@/lib/one-number/signup/flow.server";
import { readSignupIntent } from "@/lib/one-number/signup/intent";
import { createNewListingWizardSubmission } from "@/lib/manager-listing-submission";
import { listingPublicPathFor } from "@/lib/listing-slug";
import { OPERATIONS_SETTINGS_KEY } from "@/lib/settings/property-overrides.server";

const PHOTO = "https://x.supabase.co/storage/v1/object/public/listing-photos/u1/a.jpg";
const USER = "user-landlord";
const PHONE = "+12065550142";
const NOW = new Date("2026-11-24T20:00:00Z");

async function draft(db: unknown, over: Partial<Parameters<typeof saveTextListingDraft>[1]> = {}) {
  const saved = await saveTextListingDraft(db as never, { userId: USER, flowId: "ft-1", address: "6420 Phinney Ave N, Seattle", roomCount: 2, rentsUsd: [900], availabilityText: "Available now", photoUrls: [PHOTO], ...over });
  if (!saved.ok) throw new Error("draft failed");
  return saved.propertyId;
}

beforeEach(() => {
  quota.verdict = { ok: true };
  quota.calls = [];
  upload.n = 0;
});

describe("the publish core is the wizard's publish", () => {
  it("takes an owned, complete draft live with the wizard's row shape and the canonical public path", async () => {
    const db = createFakeDb({ manager_property_records: [] });
    const id = await draft(db);
    const result = await publishOwnedDraftListing(db as never, { userId: USER, propertyId: id });
    expect(result).toMatchObject({ ok: true, propertyId: id, alreadyLive: false });
    const row = db.tables.manager_property_records![0]!;
    expect(row).toMatchObject({ id, manager_user_id: USER, status: "live" });
    // property_data is what the public catalog reads (publicListingProjection): the listing, its submission and its photos.
    const prop = row.property_data as { id: string; adminPublishLive: boolean; managerUserId: string; address: string; listingSubmission: { housePhotoDataUrls: string[]; rooms: { monthlyRent: number }[] } };
    expect(prop).toMatchObject({ id, adminPublishLive: true, managerUserId: USER });
    expect(prop.address).toContain("6420 Phinney");
    expect(prop.listingSubmission.housePhotoDataUrls).toEqual([PHOTO]);
    expect(prop.listingSubmission.rooms.every((r) => r.monthlyRent === 900)).toBe(true);
    expect(row.row_data).toMatchObject({ listingId: id, managerUserId: USER });
    if (result.ok) expect(result.path).toBe(listingPublicPathFor({ id, address: prop.address }));
    // The plan cap was asked about this exact transition, with the doors the listing adds.
    expect(quota.calls).toEqual([expect.objectContaining({ ownerUserId: USER, recordId: id, nextStatus: "live", existingStatus: "draft", incomingDoors: 2 })]);
  });

  it("refuses the free plan's cap plainly and leaves the draft a draft", async () => {
    quota.verdict = { ok: false, status: 403, error: "Free includes 2 doors.", tier: "free", limit: 2, current: 2 };
    const db = createFakeDb({ manager_property_records: [] });
    const id = await draft(db);
    const result = await publishOwnedDraftListing(db as never, { userId: USER, propertyId: id });
    expect(result).toMatchObject({ ok: false, reason: "plan_limit", limit: 2 });
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
  });

  it("an unreadable plan is a failure, never a publish", async () => {
    quota.verdict = { ok: false, status: 500, error: "down" };
    const db = createFakeDb({ manager_property_records: [] });
    const id = await draft(db);
    expect(await publishOwnedDraftListing(db as never, { userId: USER, propertyId: id })).toEqual({ ok: false, reason: "unavailable" });
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
  });

  it("never publishes without a real photo, a rent, a date or an address", async () => {
    const db = createFakeDb({ manager_property_records: [] });
    const noPhoto = await draft(db, { flowId: "ft-a", photoUrls: [] });
    expect(await publishOwnedDraftListing(db as never, { userId: USER, propertyId: noPhoto })).toMatchObject({ ok: false, reason: "incomplete", missing: ["photo"] });
    const noDate = await draft(db, { flowId: "ft-b", availabilityText: null });
    expect(await publishOwnedDraftListing(db as never, { userId: USER, propertyId: noDate })).toMatchObject({ ok: false, reason: "incomplete", missing: expect.arrayContaining(["availability"]) });
    expect(db.tables.manager_property_records!.every((r) => r.status === "draft")).toBe(true);
    expect(missingForPublish(createNewListingWizardSubmission())).toEqual(expect.arrayContaining(["address", "rent", "availability", "photo"]));
  });

  // The house's Operations overrides (reminders / automated messages / task automation) are written only by their own
  // gated routes, live on the same row, and are never part of a listing payload. `POST /api/property-records` carries
  // them across a listing write for exactly that reason; PUBLISH by text rebuilds the same row and must do the same.
  it("keeps a house's Operations overrides across the publish", async () => {
    const db = createFakeDb({ manager_property_records: [] });
    const id = await draft(db);
    const override = { reminderRules: { rentDue: { daysBefore: 7 } } };
    const stored = db.tables.manager_property_records!.find((r) => r.id === id)!;
    stored.row_data = { ...(stored.row_data as Row), [OPERATIONS_SETTINGS_KEY]: override };
    expect(await publishOwnedDraftListing(db as never, { userId: USER, propertyId: id })).toMatchObject({ ok: true });
    const live = db.tables.manager_property_records!.find((r) => r.id === id)!;
    expect(live.status).toBe("live");
    expect((live.row_data as Row)[OPERATIONS_SETTINGS_KEY]).toEqual(override);
  });

  it("another account cannot publish or even see someone else's draft", async () => {
    const db = createFakeDb({ manager_property_records: [] });
    const id = await draft(db);
    const before = JSON.stringify(db.tables.manager_property_records);
    expect(await publishOwnedDraftListing(db as never, { userId: "someone-else", propertyId: id })).toEqual({ ok: false, reason: "not_found" });
    expect(await publishOwnedDraftListing(db as never, { userId: USER, propertyId: "mgr-text-nope" })).toEqual({ ok: false, reason: "not_found" });
    expect(JSON.stringify(db.tables.manager_property_records)).toBe(before);
  });

  it("a second PUBLISH changes nothing and a second listing never overwrites the first", async () => {
    const db = createFakeDb({ manager_property_records: [] });
    const first = await draft(db);
    const a = await publishOwnedDraftListing(db as never, { userId: USER, propertyId: first });
    const snapshot = JSON.stringify(db.tables.manager_property_records![0]);
    const again = await publishOwnedDraftListing(db as never, { userId: USER, propertyId: first });
    expect(again).toMatchObject({ ok: true, alreadyLive: true });
    expect(a.ok && again.ok && again.path === a.path).toBe(true);
    expect(JSON.stringify(db.tables.manager_property_records![0])).toBe(snapshot);
    // A re-save of the live row by the walkthrough's writer is refused (it only ever rewrites drafts).
    expect(await saveTextListingDraft(db as never, { userId: USER, flowId: "ft-1", address: "ZZZ", roomCount: 1, rentsUsd: [1000] })).toEqual({ ok: false, error: "changed_elsewhere" });
    const second = await draft(db, { flowId: "ft-2", address: "12 Pine St, Seattle" });
    expect(second).not.toBe(first);
    expect(db.tables.manager_property_records).toHaveLength(2);
    expect(db.tables.manager_property_records!.find((r) => r.id === first)!.status).toBe("live");
    expect(db.tables.manager_property_records!.find((r) => r.id === second)!.status).toBe("draft");
  });
});

describe("photos by MMS land on the draft", () => {
  it("re-uploads only this phone's unlinked images (max 12) and links them to the listing", async () => {
    const db = createFakeDb({
      sms_first_home_sessions: [],
      manager_property_records: [],
      sms_media_files: [
        ...Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, sender_phone_key: "2065550142", storage_path: `p/${i}.jpg`, content_type: "image/jpeg", byte_size: 1000, linked_type: null, created_at: new Date(NOW.getTime() - (20 - i) * 1000).toISOString() })),
        { id: "pdf", sender_phone_key: "2065550142", storage_path: "p/x.pdf", content_type: "application/pdf", byte_size: 1000, linked_type: null, created_at: NOW.toISOString() },
        { id: "other", sender_phone_key: "2065559999", storage_path: "p/o.jpg", content_type: "image/jpeg", byte_size: 1000, linked_type: null, created_at: NOW.toISOString() },
        { id: "linked", sender_phone_key: "2065550142", storage_path: "p/l.jpg", content_type: "image/jpeg", byte_size: 1000, linked_type: "listing", created_at: NOW.toISOString() },
      ],
    });
    (db as unknown as { storage: unknown }).storage = { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }) }) };
    const deps = { now: () => NOW, origin: "https://proplane.ai", findOwners: async () => [USER], signInLink: async () => "https://proplane.ai/l" };
    const text = (body: string, sid: string, hasMedia = false) => handleFirstHomeText(db as never, { phoneE164: PHONE, body, messageSid: sid, hasMedia }, deps as never);
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    await text("6420 Phinney Ave N", "S1");
    await text("2 rooms $900", "S2");
    await text("now", "S3");
    await text("no smoking", "S4");
    const got = await text("", "S5", true);
    expect(got).toMatchObject({ handled: true, reply: FIRST_HOME_COPY.gotPhotos(12, 12) });
    const done = await text("DONE", "S6");
    expect(done).toMatchObject({ handled: true, reply: FIRST_HOME_COPY.askPublish(12) });
    const rec = db.tables.manager_property_records![0]!;
    expect((rec.row_data as { submission: { housePhotoDataUrls: string[] } }).submission.housePhotoDataUrls).toHaveLength(12);
    const linked = db.tables.sms_media_files!.filter((r) => r.linked_type === "listing" && r.linked_id === rec.id).map((r) => r.id);
    expect(linked).toHaveLength(12);
    expect(db.tables.sms_media_files!.find((r) => r.id === "other")!.linked_type ?? null).toBeNull();
    expect(db.tables.sms_media_files!.find((r) => r.id === "pdf")!.linked_type ?? null).toBeNull();
  });
});

describe("the stall: a just-signed-up landlord's address is the walkthrough's, not the self-serve line's", () => {
  it("answerPropLaneLineText steps aside for a live walkthrough and still answers everyone else", async () => {
    vi.resetModules();
    vi.doMock("@/lib/service/service-catalog.server", () => ({ isPropLaneServiceLine: async () => mocks.onLine }));
    vi.doMock("@/lib/one-number/personal-number-redirect.server", () => ({ personalNumberRedirectFor: async () => null }));
    vi.doMock("@/lib/one-number/line-member-status.server", () => ({ handleLineMemberText, isLineKeywordOrUrgentText: () => false }));
    vi.doMock("@/lib/one-number/line-resident.server", () => ({ handleLineResidentText: async () => ({ handled: false }) }));
    vi.doMock("@/lib/one-number/router-lookups.server", () => ({ findResidentCandidates: async () => [], findVendorJobCandidates: async () => [], findVerifiedProfileByPhone: async () => null }));
    vi.doMock("@/lib/one-number/self-serve-line.server", () => ({ classifyLineWorkspaces: async () => new Map(), selfServeLineReply: async () => "x" }));
    handleLineMemberText.mockResolvedValue({ handled: true, reply: "This line is for homes PropLane manages. A personal work number comes with Pro: proplane.ai/pricing", actorUserId: USER });
    const { answerPropLaneLineText } = await import("@/lib/one-number/line-inbound.server");
    const first = await import("@/lib/one-number/signup/first-home.server");
    const db = createFakeDb({ sms_first_home_sessions: [], manager_property_records: [], sms_media_files: [] });
    const ask = (body: string) => answerPropLaneLineText(db as never, { lineOwnerUserId: "owner", toPhone: "+12065550000", fromPhone: PHONE, body });

    // Control: a free manager with NO walkthrough is told the line is for managed homes (unchanged).
    expect(await ask("6420 Phinney Ave N")).toMatchObject({ kind: "member", reply: expect.stringContaining("This line is for homes PropLane manages") });
    handleLineMemberText.mockClear();

    // The reproduced sequence: signed up, "You're set", then the address.
    await first.startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER });
    expect(await ask("6420 Phinney Ave N")).toBeNull();
    expect(await ask("")).toBeNull(); // a photo-only text has an empty body
    expect(handleLineMemberText).not.toHaveBeenCalled();
    // Another phone is unaffected.
    const other = await answerPropLaneLineText(db as never, { lineOwnerUserId: "owner", toPhone: "+12065550000", fromPhone: "+12065550999", body: "6420 Phinney Ave N" });
    expect(other).toMatchObject({ kind: "member" });
    vi.resetModules();
  });
});

describe("a failure is logged and answered, never swallowed into a fallback", () => {
  it("answers a retry prompt for a live walkthrough when the turn throws; says nothing for a stranger", async () => {
    const db = createFakeDb({ sms_first_home_sessions: [], manager_property_records: [], sms_media_files: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    const boom = { now: () => NOW, findOwners: async () => [USER], signInLink: async () => { throw new Error("boom"); } };
    // Force a throw inside the turn: the session read of a broken table after the first read.
    const original = db.from.bind(db);
    let reads = 0;
    (db as unknown as { from: unknown }).from = (t: string) => {
      if (t === "sms_first_home_sessions" && ++reads === 2) throw new Error("db down");
      return original(t);
    };
    // First read (inside handleFirstHomeText) passes, a later write throws.
    const turn = await handleFirstHomeTextSafely(db as never, { phoneE164: PHONE, body: "6420 Phinney Ave N", messageSid: "S1" }, boom as never);
    expect(turn).toEqual({ handled: true, reply: FIRST_HOME_COPY.unavailable });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await handleFirstHomeTextSafely(db as never, { phoneE164: "+12065550999", body: "hello", messageSid: "S2" }, boom as never)).toEqual({ handled: false });
    expect(await hasLiveFirstHomeSession(db as never, PHONE, NOW)).toBe(true);
    expect(await hasLiveFirstHomeSession(db as never, "+12065550999", NOW)).toBe(false);
  });
});

describe("PUBLISH by text", () => {
  const photos = vi.fn(async () => ({ urls: [PHOTO], mediaIds: [] as string[] }));
  let db: ReturnType<typeof createFakeDb>;
  let sid = 0;
  const deps = (over: Record<string, unknown> = {}) => ({ now: () => NOW, origin: "https://proplane.ai", findOwners: async () => [USER], signInLink: async () => "https://proplane.ai/auth/confirm?token_hash=H", adoptPhotos: photos, ...over });
  const text = async (body: string, over: Record<string, unknown> = {}, hasMedia = false) => {
    const turn = await handleFirstHomeText(db as never, { phoneE164: PHONE, body, messageSid: `SM${++sid}`, hasMedia }, deps(over) as never);
    return turn.handled ? turn.reply : null;
  };
  beforeEach(async () => {
    sid = 0;
    photos.mockClear();
    db = createFakeDb({ sms_first_home_sessions: [], manager_property_records: [], sms_media_files: [] });
    await startFirstHomeWalkthrough(db as never, { phoneE164: PHONE, userId: USER, now: NOW });
    await text("6420 Phinney Ave N, Seattle");
    await text("2 rooms $900 each");
  });

  it("offers PUBLISH only when a real photo and a date are in, and goes live ONLY on the PUBLISH text", async () => {
    await text("now");
    await text("skip");
    expect(await text("DONE")).toBe(FIRST_HOME_COPY.askPublish(1));
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    // Anything else never posts.
    for (const word of ["yes", "ok", "post it", "go live", "publish?? no wait"]) {
      expect(await text(word)).toBe(FIRST_HOME_COPY.remindPublish);
      expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    }
    const live = await text("PUBLISH");
    expect(live).toContain("It is live!");
    expect(live).toContain("https://proplane.ai/rent/listings/6420-phinney-ave-n");
    expect(live).toContain("https://proplane.ai/auth/confirm?token_hash=H");
    expect(db.tables.manager_property_records![0]!.status).toBe("live");
    expect(db.tables.sms_first_home_sessions).toHaveLength(0);
    // The session ended: a second PUBLISH is not this walkthrough's (and could not change the record anyway).
    expect(await text("PUBLISH")).toBeNull();
  });

  it("asks for the move-in date first when it was skipped, one question per text", async () => {
    await text("skip");
    await text("skip");
    expect(await text("DONE")).toBe(FIRST_HOME_COPY.askPublishAvailable);
    expect(await text("sometime")).toBe(FIRST_HOME_COPY.retryPublishAvailable);
    expect(await text("PUBLISH")).toBe(FIRST_HOME_COPY.retryPublishAvailable);
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    expect(await text("Dec 1")).toBe(FIRST_HOME_COPY.askPublish(1));
    expect(await text("publish")).toContain("It is live!");
    const sub = (db.tables.manager_property_records![0]!.property_data as { listingSubmission: { rooms: { availability: string }[]; housePhotoDataUrls: string[] } }).listingSubmission;
    expect(sub.rooms.every((r) => r.availability === "Available Dec 1")).toBe(true);
    expect(sub.housePhotoDataUrls).toEqual([PHOTO]);
  });

  it("with no photo it does not offer PUBLISH: DONE asks for one, SKIP leaves a draft and the portal link", async () => {
    photos.mockResolvedValue({ urls: [], mediaIds: [] });
    await text("now");
    await text("skip");
    expect(await text("DONE")).toBe(FIRST_HOME_COPY.noPhotosYet);
    const skipped = await text("SKIP");
    expect(skipped).toContain("saved as a draft");
    expect(skipped).toContain("needs at least one photo");
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    photos.mockResolvedValue({ urls: [PHOTO], mediaIds: [] });
  });

  it("the free plan's cap is said plainly with the upgrade link, the draft stays, and PUBLISH works again after upgrading", async () => {
    await text("now");
    await text("skip");
    await text("DONE");
    quota.verdict = { ok: false, status: 403, error: "Free includes 2 doors.", tier: "free", limit: 2, current: 2 };
    const refused = await text("PUBLISH");
    expect(refused).toBe(FIRST_HOME_COPY.planLimit("https://proplane.ai/auth/confirm?token_hash=H", "https://proplane.ai/pricing"));
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
    quota.verdict = { ok: true };
    expect(await text("PUBLISH")).toContain("It is live!");
  });

  it("more photos at the publish step are added to the same draft", async () => {
    await text("now");
    await text("skip");
    await text("DONE");
    photos.mockResolvedValueOnce({ urls: ["https://x.supabase.co/storage/v1/object/public/listing-photos/u1/b.jpg"], mediaIds: [] });
    expect(await text("", {}, true)).toBe(FIRST_HOME_COPY.morePhotos(1, 2));
    const sub = (db.tables.manager_property_records![0]!.row_data as { submission: { housePhotoDataUrls: string[] } }).submission;
    expect(sub.housePhotoDataUrls).toHaveLength(2);
  });

  it("another phone can never attach to or change it", async () => {
    await text("now");
    await text("skip");
    await text("DONE");
    const intruder = await handleFirstHomeText(db as never, { phoneE164: "+12065550999", body: "PUBLISH", messageSid: "X1" }, deps() as never);
    expect(intruder).toEqual({ handled: false });
    // The right phone, but the account no longer owns it: fails closed.
    expect(await text("PUBLISH", { findOwners: async () => ["someone-else"] })).toBeNull();
    expect(db.tables.manager_property_records![0]!.status).toBe("draft");
  });
});

describe("end to end by text: intent -> sign-up -> code -> home -> photos -> PUBLISH -> live", () => {
  it("runs the captain's sentence to a live listing on the public site", async () => {
    const f = linksFakeDb({ manager_property_records: [], sms_media_files: [] });
    const state = { sid: 0, owners: [] as string[] };
    const signupDeps: SignupDeps = {
      now: () => NOW,
      origin: "https://proplane.ai",
      findOwners: async () => state.owners,
      provision: async () => {
        state.owners = [USER];
        return { ok: true, userId: USER, email: "x@phone.proplane.invalid" };
      },
      signInLink: async () => "https://proplane.ai/auth/confirm?token_hash=H&type=magiclink",
      webLink: async (_db, { role }) => `https://proplane.ai/start/WEB-${role}`,
    };
    const photoDeps = { now: () => NOW, origin: "https://proplane.ai", findOwners: async () => state.owners, signInLink: async () => "https://proplane.ai/auth/confirm?token_hash=H", adoptPhotos: async () => ({ urls: [PHOTO], mediaIds: [] as string[] }) };
    // The pipeline's order for this line: the walkthrough first, the sign-up flow when the phone has no walkthrough.
    const say = async (body: string, hasMedia = false) => {
      state.sid += 1;
      const input = { phoneE164: PHONE, body, messageSid: `SM${state.sid}` };
      const home = await handleFirstHomeText(f.db, { ...input, hasMedia }, photoDeps as never);
      if (home.handled) return home.reply;
      const turn = await handleSmsSignupText(f.db, input, signupDeps);
      return turn.handled ? turn.reply : null;
    };

    // 1. The captain's sentence is a manager sign-up and the FIRST reply carries the phone-bound web setup link.
    expect(readSignupIntent("HEY I WANT TO LIST MY PROPERTY")).toMatchObject({ wantsSignup: true, role: "manager" });
    const first = await say("HEY I WANT TO LIST MY PROPERTY");
    expect(first).toContain("https://proplane.ai/start/WEB-manager");
    expect(first).toContain("full name");
    // 2. Account by text, proven by the code echo.
    await say("Priya Landlord");
    await say("Priya Rentals");
    await say("2");
    const codeReply = await say("SKIP");
    const code = /code: (\d{6})/.exec(codeReply ?? "")?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    expect(f.rows.manager_property_records).toHaveLength(0);
    const set = await say(code);
    expect(set).toContain("You're set, Priya");
    expect(set).toContain(FIRST_HOME_COPY.askAddress);
    // 3. The address is the walkthrough's (the stall), then rooms and rent, the date, rules, photos.
    expect(await say("6420 Phinney Ave N, Seattle")).toBe(FIRST_HOME_COPY.askRooms);
    expect(await say("2 rooms $950 each")).toBe(FIRST_HOME_COPY.askAvailable);
    expect(await say("Dec 1")).toBe(FIRST_HOME_COPY.askRules);
    expect(await say("no smoking")).toBe(FIRST_HOME_COPY.askPhotos);
    expect(f.rows.manager_property_records![0]).toMatchObject({ status: "draft", manager_user_id: USER });
    expect(await say("DONE")).toBe(FIRST_HOME_COPY.askPublish(1));
    expect(f.rows.manager_property_records![0]!.status).toBe("draft");
    // 4. PUBLISH goes live through the publish core.
    const live = await say("PUBLISH");
    expect(live).toContain("It is live!");
    expect(live).toContain("https://proplane.ai/rent/listings/6420-phinney-ave-n");
    const record = f.rows.manager_property_records![0]!;
    expect(record).toMatchObject({ status: "live", manager_user_id: USER });
    expect(f.rows.manager_property_records).toHaveLength(1);
    const prop = record.property_data as { listingSubmission: { rooms: { monthlyRent: number; availability: string }[]; houseRulesText: string; housePhotoDataUrls: string[] } };
    expect(prop.listingSubmission.rooms.map((r) => [r.monthlyRent, r.availability])).toEqual([[950, "Available Dec 1"], [950, "Available Dec 1"]]);
    expect(prop.listingSubmission.houseRulesText).toBe("no smoking");
    expect(prop.listingSubmission.housePhotoDataUrls).toEqual([PHOTO]);
    expect(f.rows.sms_first_home_sessions ?? []).toHaveLength(0);
  });
});
