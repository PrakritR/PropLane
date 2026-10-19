// A prospect who picked a home on the shared line reaches the leasing agent with it already chosen
// (found by the end-to-end harness: the agent answered "I don't have a listing matched yet").
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));

import { handoffFromLead, handoffPrompt, loadLeadHandoffPrompt } from "@/lib/one-number/lead-handoff-context.server";

const offers = [
  { n: 1, propertyId: "prop-1", roomId: "prop-1-r1", label: "5359 Ballard Ave NW", rent: 900, availability: "available now" },
  { n: 2, propertyId: "prop-2", roomId: "prop-2-r1", label: "1420 Magnolia Ave", rent: 1250, availability: "available now" },
];
const lead = (over: Record<string, unknown> = {}) => ({
  id: "lead-1", phone_key: "2065550142", status: "assigned", assigned_workspace_id: "ws-a", assigned_property_id: "prop-1",
  assigned_at: new Date().toISOString(), profile: { stage: "assigned", budgetMax: 1500, moveInDate: "2026-10-20", leaseMonths: 12, offers }, ...over,
});
const world = (rows: Record<string, unknown>[]) =>
  createMemoryDb({ portal_workspaces: [{ id: "ws-a", owner_user_id: "owner-a", name: "A" }], sms_unassigned_leads: rows });

describe("lead hand-off to the leasing agent", () => {
  it("finds the picked room behind the stored offers", () => {
    expect(handoffFromLead(lead())).toMatchObject({ propertyId: "prop-1", roomId: "prop-1-r1", label: "5359 Ballard Ave NW", rent: 900, budgetMax: 1500 });
  });

  it("the prompt carries ids and the prospect's own answers, nothing else", () => {
    const prompt = handoffPrompt(handoffFromLead(lead())!);
    expect(prompt).toContain('"propertyId":"prop-1"');
    expect(prompt).toContain('"roomId":"prop-1-r1"');
    expect(prompt).toContain("theirMonthlyBudget");
    expect(prompt).not.toMatch(/2065550142/);
  });

  it("is loaded for the team that owns the lead, by phone", async () => {
    const prompt = await loadLeadHandoffPrompt(world([lead()]) as never, { ownerUserId: "owner-a", workspaceId: "ws-a", phone: "+12065550142" });
    expect(prompt).toContain("prop-1");
  });

  it("never for another owner's workspace, another phone, an old hand-off, or an open lead", async () => {
    const db = world([lead()]) as never;
    expect(await loadLeadHandoffPrompt(db, { ownerUserId: "owner-b", workspaceId: "ws-a", phone: "+12065550142" })).toBeNull();
    expect(await loadLeadHandoffPrompt(db, { ownerUserId: "owner-a", workspaceId: "ws-a", phone: "+12065550199" })).toBeNull();
    expect(await loadLeadHandoffPrompt(world([lead({ assigned_at: "2026-01-01T00:00:00Z" })]) as never, { ownerUserId: "owner-a", workspaceId: "ws-a", phone: "+12065550142" })).toBeNull();
    expect(await loadLeadHandoffPrompt(world([lead({ status: "open" })]) as never, { ownerUserId: "owner-a", workspaceId: "ws-a", phone: "+12065550142" })).toBeNull();
  });
});
