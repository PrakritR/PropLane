import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const addServiceVendor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/service/service-vendors.server", () => ({ addServiceVendor }));
const setVendorLeadStatus = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/one-number/onboarding/vendor-intake.server", () => ({ setVendorLeadStatus }));
vi.mock("@/lib/admin/admin-subscribers.server", () => ({ loadSubscriberPopulation: vi.fn() }));
vi.mock("@/lib/auth/admin-portal-manager-ids.server", () => ({ loadProfilesByIdChunks: vi.fn() }));

import { convertVendorLead } from "@/lib/service/service-network.server";
import { joinedLabel, tradesFromLeadText } from "@/lib/service/service-network";
import { freeManagerFacts, leadFacts, networkBucketFromParam } from "@/components/portal/admin-service-network";

function leadDb(row: Record<string, unknown> | null, error: unknown = null) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
  } as never;
}

describe("vendor lead conversion", () => {
  it("adds the lead's own phone to the roster, then marks the lead approved", async () => {
    addServiceVendor.mockResolvedValueOnce({ ok: true, intro: "sent", vendor: {} });
    const out = await convertVendorLead(leadDb({ id: "l1", phone_key: "+12065550142", status: "pending" }), "admin-1", "l1", { name: "Ana", trades: ["cleaner"], area: "Seattle" });
    expect(out).toEqual({ ok: true, intro: "sent" });
    expect(addServiceVendor).toHaveBeenCalledWith(expect.anything(), "admin-1", { name: "Ana", phone: "+12065550142", trades: ["cleaner"], area: "Seattle" });
    expect(setVendorLeadStatus).toHaveBeenCalledWith(expect.anything(), "l1", "approved");
  });

  it("leaves the lead pending when the roster add fails, and refuses a lead already handled", async () => {
    setVendorLeadStatus.mockClear();
    addServiceVendor.mockResolvedValueOnce({ ok: false, status: 409, error: "That number is already on the list." });
    const failed = await convertVendorLead(leadDb({ id: "l1", phone_key: "+12065550142", status: "pending" }), "a", "l1", { name: "Ana", trades: ["cleaner"] });
    expect(failed).toEqual({ ok: false, status: 409, error: "That number is already on the list." });
    expect(setVendorLeadStatus).not.toHaveBeenCalled();
    const handled = await convertVendorLead(leadDb({ id: "l1", phone_key: "+12065550142", status: "approved" }), "a", "l1", {});
    expect(handled).toMatchObject({ ok: false, status: 409 });
    expect(await convertVendorLead(leadDb(null), "a", "x", {})).toMatchObject({ ok: false, status: 404 });
  });
});

describe("network helpers", () => {
  it("maps a lead's free-text trade to roster trades", () => {
    expect(tradesFromLeadText("cleaning")).toEqual(["cleaner"]);
    expect(tradesFromLeadText("plumbing and handyman")).toEqual(["plumber", "handyman"]);
    expect(tradesFromLeadText(null)).toEqual([]);
  });

  it("reads the bucket and draws glyph facts without pills", () => {
    expect(networkBucketFromParam("managers")).toBe("managers");
    expect(networkBucketFromParam("nope")).toBe("leads");
    expect(joinedLabel("2026-10-05T12:00:00Z")).toBe("Joined Oct 2026");
    expect(leadFacts({ id: "1", phoneMasked: "•••• 0142", trade: "cleaning", area: null, createdAt: "2026-10-18T20:00:00Z" }).map((f) => f.label)).toEqual(["•••• 0142", "Cleaning", "Texted Oct 18"]);
    const facts = freeManagerFacts({ id: "m", accountKey: "manager-m", name: "Sam", email: "s@x.co", proplaneId: "P1", houseCount: 1, joinedAt: "2026-10-05T12:00:00Z", city: "Seattle" });
    expect(facts.map((f) => f.label)).toEqual(["1 house", "Seattle", "Joined Oct 2026"]);
  });
});
