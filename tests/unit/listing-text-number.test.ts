/**
 * One rule for the number a public listing says to text: PropLane-managed workspace -> the PropLane line;
 * a customer's own workspace -> its own active work number, else the PropLane line. A failed is_service
 * read is treated as not managed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROPLANE_LINE = "+12065550100";
const OWN = "+14255550123";

const ownNumber = vi.hoisted(() => vi.fn());
const publicConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: ownNumber }));
vi.mock("@/lib/marketing/public-texting.server", () => ({ getPublicTextingConfig: publicConfig }));

import { resolveListingTextNumber, resolveListingTextNumbers, listingTextNumberKey } from "@/lib/listing-text-number.server";

function makeDb(result: { data: unknown; error: unknown } | "throw") {
  const inFn = vi.fn(async () => {
    if (result === "throw") throw new Error("boom");
    return result;
  });
  const select = vi.fn(() => ({ in: inFn }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, select, inFn };
}

const MANAGED_WS = "ws-managed";
const SELF_WS = "ws-self";
const SELF_NO_NUMBER_WS = "ws-self-empty";
const workspaces = {
  data: [
    { id: MANAGED_WS, is_service: true },
    { id: SELF_WS, is_service: false },
    { id: SELF_NO_NUMBER_WS, is_service: false },
  ],
  error: null,
};

beforeEach(() => {
  ownNumber.mockReset();
  publicConfig.mockReset();
  publicConfig.mockResolvedValue({ phone: PROPLANE_LINE, smsHref: `sms:${PROPLANE_LINE}` });
  ownNumber.mockImplementation(async (_db: unknown, owner: string) => (owner === "owner-empty" ? null : OWN));
});

describe("resolveListingTextNumber", () => {
  it("texts the PropLane line for a managed workspace even when it has its own number", async () => {
    const { db } = makeDb(workspaces);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-a", workspaceId: MANAGED_WS })).resolves.toBe(PROPLANE_LINE);
  });

  it("texts a self-serve workspace's own number", async () => {
    const { db } = makeDb(workspaces);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-a", workspaceId: SELF_WS })).resolves.toBe(OWN);
    expect(publicConfig).not.toHaveBeenCalled();
  });

  it("falls back to the PropLane line for a self-serve workspace with no number", async () => {
    const { db } = makeDb(workspaces);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-empty", workspaceId: SELF_NO_NUMBER_WS })).resolves.toBe(PROPLANE_LINE);
  });

  it("returns null when there is neither an own number nor a PropLane line", async () => {
    publicConfig.mockResolvedValue({ phone: null, smsHref: null });
    const { db } = makeDb(workspaces);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-empty", workspaceId: SELF_WS })).resolves.toBeNull();
  });

  it.each([
    ["an error result", { data: null, error: { message: "nope" } }],
    ["a thrown read", "throw" as const],
  ])("treats %s on the is_service read as not managed (own number, else the PropLane line)", async (_label, result) => {
    const { db } = makeDb(result);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-a", workspaceId: MANAGED_WS })).resolves.toBe(OWN);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-empty", workspaceId: MANAGED_WS })).resolves.toBe(PROPLANE_LINE);
  });

  it("a house with no workspace id is never managed and reads nothing", async () => {
    const { db, from } = makeDb(workspaces);
    await expect(resolveListingTextNumber(db, { ownerUserId: "owner-a", workspaceId: null })).resolves.toBe(OWN);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("resolveListingTextNumbers (catalog batch)", () => {
  it("mixes managed and self-serve houses with one workspace read", async () => {
    const { db, from, inFn } = makeDb(workspaces);
    const targets = [
      { ownerUserId: "owner-a", workspaceId: MANAGED_WS },
      { ownerUserId: "owner-a", workspaceId: SELF_WS },
      { ownerUserId: "owner-empty", workspaceId: SELF_NO_NUMBER_WS },
      { ownerUserId: "owner-a", workspaceId: MANAGED_WS },
    ];
    const out = await resolveListingTextNumbers(db, targets);
    expect(out.get(listingTextNumberKey(targets[0]!))).toBe(PROPLANE_LINE);
    expect(out.get(listingTextNumberKey(targets[1]!))).toBe(OWN);
    expect(out.get(listingTextNumberKey(targets[2]!))).toBe(PROPLANE_LINE);
    expect(from).toHaveBeenCalledTimes(1);
    expect(inFn).toHaveBeenCalledWith("id", expect.arrayContaining([MANAGED_WS, SELF_WS, SELF_NO_NUMBER_WS]));
    expect(publicConfig).toHaveBeenCalledTimes(1);
  });
});
