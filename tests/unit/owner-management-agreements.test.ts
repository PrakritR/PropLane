import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

const grants = vi.hoisted(() => ({ value: [] as Array<{ managerUserId: string; houses: Array<{ propertyId: string }> }> }));
vi.mock("@/lib/property-owner/access.server", () => ({ loadOwnerGrants: vi.fn(async () => grants.value) }));
const email = vi.hoisted(() => vi.fn(async () => ({ status: "sent" })));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: email }));
const text = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: text }));
vi.mock("@/lib/reports/display-context", () => ({
  loadManagerReportDisplayContext: vi.fn(async () => ({ propertyLabel: () => "5259 Brooklyn" })),
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.test" }));

import {
  AgreementError,
  createDraftAgreement,
  endAgreement,
  listAgreementsForOwner,
  sendAgreementForSignature,
  setOwnerRepairThreshold,
  signAgreement,
  updateDraftAgreement,
  type AgreementActor,
} from "@/lib/owner-management/agreements.server";
import type { OwnerAgreementTerms } from "@/lib/owner-management/fee-math";

const MANAGER = "mgr-1";
const OWNER = "own-1";
const PROP = "prop-1";
const terms: OwnerAgreementTerms = {
  feeModel: "percent_of_collected", feeBps: 800, feeFlatCents: 0, leasingFeeBps: 0, minFeeCents: 0,
  repairApprovalThresholdCents: 25_000, reserveTargetCents: 0,
};
const manager: AgreementActor = { role: "manager", userId: MANAGER };

function seed(extra: Record<string, FakeRow[]> = {}) {
  return fakeOwnerDb(
    {
      manager_property_records: [{ id: PROP, manager_user_id: MANAGER, workspace_id: "ws-1" }],
      profiles: [{ id: OWNER, email: "owner@x.test", full_name: "Olive Owner", phone: "+12065550100", phone_verified_at: "2026-01-01" }],
      owner_management_agreements: [],
      ...extra,
    },
    { uniques: { owner_management_agreements: [] } },
  );
}

beforeEach(() => {
  grants.value = [{ managerUserId: MANAGER, houses: [{ propertyId: PROP }] }];
  email.mockClear();
  text.mockClear();
});

const input = { propertyId: PROP, ownerUserId: OWNER, terms, startsOn: "2026-11-01", endsOn: null };

describe("create", () => {
  it("drafts an agreement for the property's own manager and a granted owner", async () => {
    const f = seed();
    const row = await createDraftAgreement(f.db, manager, input);
    expect(row).toMatchObject({ status: "draft", managerUserId: MANAGER, ownerUserId: OWNER, propertyId: PROP });
    expect(f.rows.owner_management_agreements).toHaveLength(1);
  });
  it("refuses a co-manager or anyone who does not own the house", async () => {
    const f = seed();
    await expect(createDraftAgreement(f.db, { role: "manager", userId: "someone-else" }, input)).rejects.toMatchObject({ status: 403 });
    expect(f.rows.owner_management_agreements).toHaveLength(0);
  });
  it("lets a platform admin act for the house's manager, and stamps the property's manager, not the admin", async () => {
    const f = seed();
    const row = await createDraftAgreement(f.db, { role: "admin", userId: "admin-1" }, input);
    expect(row.managerUserId).toBe(MANAGER);
  });
  it("refuses an owner who does not hold that house", async () => {
    grants.value = [{ managerUserId: MANAGER, houses: [{ propertyId: "other-prop" }] }];
    const f = seed();
    await expect(createDraftAgreement(f.db, manager, input)).rejects.toMatchObject({ status: 422 });
  });
  it("refuses an owner whose membership is under a different manager", async () => {
    grants.value = [{ managerUserId: "mgr-2", houses: [{ propertyId: PROP }] }];
    const f = seed();
    await expect(createDraftAgreement(f.db, manager, input)).rejects.toMatchObject({ status: 422 });
  });
  it("refuses a second agreement while one is open", async () => {
    const f = seed();
    await createDraftAgreement(f.db, manager, input);
    await expect(createDraftAgreement(f.db, manager, input)).rejects.toMatchObject({ status: 409 });
  });
  it("validates the fee terms and dates", async () => {
    const f = seed();
    await expect(createDraftAgreement(f.db, manager, { ...input, terms: { ...terms, feeBps: 5000 } })).rejects.toMatchObject({ status: 400 });
    await expect(createDraftAgreement(f.db, manager, { ...input, startsOn: "soon" })).rejects.toMatchObject({ status: 400 });
    await expect(createDraftAgreement(f.db, manager, { ...input, endsOn: "2026-10-01" })).rejects.toMatchObject({ status: 400 });
  });
  it("a missing house is a 404", async () => {
    const f = seed();
    await expect(createDraftAgreement(f.db, manager, { ...input, propertyId: "ghost" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("send for signature", () => {
  it("marks it sent and emails and texts the owner a sign-in link", async () => {
    const f = seed();
    const draft = await createDraftAgreement(f.db, manager, input);
    const result = await sendAgreementForSignature(f.db, manager, draft.id, new Date("2026-10-18T20:00:00Z"));
    expect(result.agreement.sentAt).toBeTruthy();
    expect(result.emailed).toBe(true);
    expect(result.texted).toBe(true);
    const body = (text.mock.calls[0]![0] as unknown as { body: string }) ?? null;
    expect(body).toBeTruthy();
    expect(JSON.stringify(text.mock.calls[0])).toContain("/auth/sign-in?next=");
    expect(JSON.stringify(text.mock.calls[0])).toContain(encodeURIComponent(`/portal/owner/agreements/${draft.id}`));
  });
  it("does not resend inside the hour", async () => {
    const f = seed();
    const draft = await createDraftAgreement(f.db, manager, input);
    await sendAgreementForSignature(f.db, manager, draft.id, new Date("2026-10-18T20:00:00Z"));
    await expect(sendAgreementForSignature(f.db, manager, draft.id, new Date("2026-10-18T20:30:00Z"))).rejects.toMatchObject({ status: 429 });
    await expect(sendAgreementForSignature(f.db, manager, draft.id, new Date("2026-10-18T21:30:00Z"))).resolves.toBeTruthy();
  });
  it("refuses a stranger and refuses once the owner lost the house", async () => {
    const f = seed();
    const draft = await createDraftAgreement(f.db, manager, input);
    await expect(sendAgreementForSignature(f.db, { role: "manager", userId: "x" }, draft.id)).rejects.toMatchObject({ status: 403 });
    grants.value = [];
    await expect(sendAgreementForSignature(f.db, manager, draft.id)).rejects.toMatchObject({ status: 422 });
  });
});

describe("sign", () => {
  async function sent() {
    const f = seed();
    const draft = await createDraftAgreement(f.db, manager, input);
    await sendAgreementForSignature(f.db, manager, draft.id);
    return { f, id: draft.id };
  }
  it("activates with a hash of the exact terms and the signature time", async () => {
    const { f, id } = await sent();
    const row = await signAgreement(f.db, OWNER, id, new Date("2026-10-19T00:00:00Z"));
    expect(row.status).toBe("active");
    expect(row.signedAt).toBe("2026-10-19T00:00:00.000Z");
    expect(row.termsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((f.rows.owner_management_agreements[0] as { terms_snapshot: { feeBps: number } }).terms_snapshot.feeBps).toBe(800);
  });
  it("is idempotent for the same owner", async () => {
    const { f, id } = await sent();
    const first = await signAgreement(f.db, OWNER, id);
    const again = await signAgreement(f.db, OWNER, id);
    expect(again.termsSha256).toBe(first.termsSha256);
  });
  it("is a 404 for anyone but the named owner (no existence leak)", async () => {
    const { f, id } = await sent();
    await expect(signAgreement(f.db, "intruder", id)).rejects.toMatchObject({ status: 404 });
  });
  it("refuses an agreement that was never sent", async () => {
    const f = seed();
    const draft = await createDraftAgreement(f.db, manager, input);
    await expect(signAgreement(f.db, OWNER, draft.id)).rejects.toMatchObject({ status: 409 });
  });
  it("refuses once the owner's access was revoked", async () => {
    const { f, id } = await sent();
    grants.value = [];
    await expect(signAgreement(f.db, OWNER, id)).rejects.toMatchObject({ status: 403 });
  });
  it("editing a sent draft clears the send, so the owner cannot sign terms they did not see", async () => {
    const { f, id } = await sent();
    await updateDraftAgreement(f.db, manager, id, { terms: { ...terms, feeBps: 900 } });
    await expect(signAgreement(f.db, OWNER, id)).rejects.toMatchObject({ status: 409 });
  });
  it("a signed agreement cannot be edited", async () => {
    const { f, id } = await sent();
    await signAgreement(f.db, OWNER, id);
    await expect(updateDraftAgreement(f.db, manager, id, { terms: { ...terms, feeBps: 900 } })).rejects.toMatchObject({ status: 409 });
  });
});

describe("end and the owner's threshold", () => {
  it("ends an active agreement from today and stays ended", async () => {
    const f = seed();
    const d = await createDraftAgreement(f.db, manager, input);
    await sendAgreementForSignature(f.db, manager, d.id);
    await signAgreement(f.db, OWNER, d.id);
    const ended = await endAgreement(f.db, manager, d.id, new Date("2026-12-05T18:00:00Z"));
    expect(ended.status).toBe("ended");
    expect(ended.endsOn).toBe("2026-12-05");
    expect((await endAgreement(f.db, manager, d.id)).status).toBe("ended");
  });
  it("only the house's manager may end it", async () => {
    const f = seed();
    const d = await createDraftAgreement(f.db, manager, input);
    await expect(endAgreement(f.db, { role: "manager", userId: "x" }, d.id)).rejects.toMatchObject({ status: 403 });
  });
  it("the owner sets their own repair threshold, within range, and nobody else can", async () => {
    const f = seed();
    const d = await createDraftAgreement(f.db, manager, input);
    const row = await setOwnerRepairThreshold(f.db, OWNER, d.id, 50_000);
    expect(row.terms.repairApprovalThresholdCents).toBe(50_000);
    await expect(setOwnerRepairThreshold(f.db, OWNER, d.id, -1)).rejects.toBeInstanceOf(AgreementError);
    await expect(setOwnerRepairThreshold(f.db, "intruder", d.id, 100)).rejects.toMatchObject({ status: 404 });
  });
});

describe("what an owner can list", () => {
  it("shows only their own sent agreements, and nothing once revoked", async () => {
    const f = seed();
    const d = await createDraftAgreement(f.db, manager, input);
    expect(await listAgreementsForOwner(f.db, OWNER)).toHaveLength(0); // never sent
    await sendAgreementForSignature(f.db, manager, d.id);
    const mine = await listAgreementsForOwner(f.db, OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ houseLabel: "5259 Brooklyn", feeLine: "8% of rent collected" });
    expect(await listAgreementsForOwner(f.db, "someone-else")).toHaveLength(0);
    grants.value = [];
    expect(await listAgreementsForOwner(f.db, OWNER)).toHaveLength(0);
  });
  it("a database without the table lists nothing", async () => {
    const f = fakeOwnerDb({}, { broken: ["owner_management_agreements"] });
    expect(await listAgreementsForOwner(f.db, OWNER)).toEqual([]);
  });
});
