// Quiet leads: one nudge at 24h, one at 72h, then nothing. Shared line only, never in quiet hours,
// never to an opted-out number, never twice.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";
import { storedListing } from "../helpers/lead-listing-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: vi.fn() }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: vi.fn(async () => true) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));

import { publicListingProjection } from "@/lib/public-listings.server";
import {
  NUDGE_FIRST_AFTER_MS,
  NUDGE_SECOND_AFTER_MS,
  dueNudge,
  nudgeText,
  runLeadFollowUps,
  type FollowUpDeps,
} from "@/lib/one-number/lead-followups.server";
import type { LeadProfile } from "@/lib/one-number/lead-qualifying";

const HOUR = 60 * 60 * 1000;
// 1pm Pacific on a Sunday.
const NOW = new Date("2026-10-18T20:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function db(leads: Array<{ id: string; quietMs: number; profile?: LeadProfile; status?: string; phone?: string }>, mode = "shared"): LeadFakeDb {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100" }],
      sms_unassigned_leads: leads.map((l) => ({
        id: l.id,
        phone_key: l.phone ?? `20655501${l.id.slice(-2)}`,
        status: l.status ?? "open",
        profile: l.profile ?? { stage: "qualifying", asked: "budget" },
        last_inbound_at: ago(l.quietMs),
        updated_at: ago(l.quietMs),
      })),
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

function harness(over: Partial<FollowUpDeps> = {}) {
  const send = vi.fn(async (_db: unknown, _input: { to: string; body: string; mediaUrls?: string[] }) => ({ ok: true as const, sid: "SMX" }));
  const deps: FollowUpDeps = { now: () => NOW, listings: async () => [], origin: () => "https://proplane.ai", send: send as FollowUpDeps["send"], ...over };
  return { send, deps };
}

describe("which nudge is due", () => {
  it("none before 24h, the first from 24h, the second from 72h, nothing after", () => {
    const fresh: LeadProfile = { stage: "qualifying", asked: "budget" };
    expect(dueNudge(fresh, 23 * HOUR)).toBeNull();
    expect(dueNudge(fresh, NUDGE_FIRST_AFTER_MS)).toBe("24");
    expect(dueNudge({ ...fresh, nudged24: "x" }, 48 * HOUR)).toBeNull();
    expect(dueNudge({ ...fresh, nudged24: "x" }, NUDGE_SECOND_AFTER_MS)).toBe("72");
    expect(dueNudge({ ...fresh, nudged24: "x", nudged72: "y" }, 200 * HOUR)).toBeNull();
    // a lead the cron missed at 24h still gets only the 72h one
    expect(dueNudge(fresh, 80 * HOUR)).toBe("72");
  });
  it("leaves a matched lead and a no-match lead out of the nudges", () => {
    expect(dueNudge({ stage: "assigned" }, 30 * HOUR)).toBeNull();
    expect(dueNudge({ stage: "no_match" }, 30 * HOUR)).toBeNull();
  });
  it("writes plain, short, STOP-aware copy that re-asks the pending question", () => {
    expect(nudgeText("24", { stage: "qualifying", asked: "budget" })).toBe("Hi, this is PropLane. Still looking for a room? What is your monthly budget for rent?");
    expect(nudgeText("24", { stage: "offered", offers: [{ n: 1, propertyId: "p", roomId: "r", label: "x", rent: 1, availability: "" }, { n: 2, propertyId: "q", roomId: "r", label: "y", rent: 1, availability: "" }] })).toBe(
      "Hi, this is PropLane. Still interested in one of those rooms? Reply 1 or 2, or TOUR.",
    );
    expect(nudgeText("72", {})).toContain("Reply STOP to opt out.");
    for (const text of [nudgeText("24", {}), nudgeText("72", {})]) {
      expect(/^[\x20-\x7E]*$/.test(text)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("the sweep", () => {
  it("sends the 24h nudge once, records it, and never again", async () => {
    const fake = db([{ id: "lead-01", quietMs: 25 * HOUR }]);
    const { send, deps } = harness();
    const first = await runLeadFollowUps(fake.db, deps);
    expect(first).toMatchObject({ considered: 1, nudged24: 1, nudged72: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ to: "+12065550101" });
    expect(send.mock.calls[0]![1].body).toContain("Still looking for a room?");
    expect(fake.rows.sms_unassigned_leads![0]!.profile).toMatchObject({ nudged24: NOW.toISOString() });
    expect(fake.rows.sms_unassigned_lead_turns!.map((t) => t.message_sid)).toEqual(["nudge:lead-01:24"]);

    await runLeadFollowUps(fake.db, deps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("then one at 72h, then nothing for good", async () => {
    const fake = db([{ id: "lead-02", quietMs: 73 * HOUR, profile: { stage: "qualifying", asked: "budget", nudged24: ago(48 * HOUR) } }]);
    const { send, deps } = harness();
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ nudged72: 1, nudged24: 0 });
    expect(send.mock.calls[0]![1].body).toContain("Reply STOP to opt out.");
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ nudged72: 0, nudged24: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(fake.rows.sms_unassigned_leads![0]!.profile).toMatchObject({ nudged72: NOW.toISOString() });
  });

  it("does not nudge a lead that is too fresh, closed, assigned, or quiet for over 30 days", async () => {
    const fake = db([
      { id: "lead-03", quietMs: 5 * HOUR },
      { id: "lead-04", quietMs: 30 * HOUR, status: "closed" },
      { id: "lead-05", quietMs: 30 * HOUR, status: "assigned" },
      { id: "lead-06", quietMs: 31 * 24 * HOUR },
    ]);
    const { send, deps } = harness();
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ considered: 0, nudged24: 0, nudged72: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing off the shared line", async () => {
    for (const mode of ["per_workspace", "shadow"]) {
      const fake = db([{ id: "lead-07", quietMs: 30 * HOUR }], mode);
      const { send, deps } = harness();
      expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ skipped: "not_shared_mode", nudged24: 0 });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("holds every nudge in quiet hours", async () => {
    const fake = db([{ id: "lead-08", quietMs: 30 * HOUR }]);
    const { send, deps } = harness({ now: () => new Date("2026-10-19T08:00:00Z") });
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ skipped: "quiet_hours" });
    expect(send).not.toHaveBeenCalled();
  });

  it("a number that opted out leaves the queue and is never retried", async () => {
    const fake = db([{ id: "lead-09", quietMs: 30 * HOUR }]);
    const refused = vi.fn(async () => ({ ok: false as const, reason: "opted_out" as const }));
    const { deps } = harness({ send: refused as unknown as FollowUpDeps["send"] });
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ nudged24: 0, optedOut: 1 });
    expect(fake.rows.sms_unassigned_leads![0]!.status).toBe("closed");
    await runLeadFollowUps(fake.db, deps);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(fake.rows.sms_unassigned_lead_turns ?? []).toEqual([]);
  });

  it("a provider hiccup takes the flag back, so the next sweep retries and nothing is recorded as sent", async () => {
    const fake = db([{ id: "lead-13", quietMs: 30 * HOUR }]);
    const failing = vi.fn(async () => ({ ok: false as const, reason: "provider_error" as const }));
    const { deps } = harness({ send: failing as unknown as FollowUpDeps["send"] });
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ nudged24: 0, optedOut: 0 });
    expect(fake.rows.sms_unassigned_leads![0]!.status).toBe("open");
    expect(fake.rows.sms_unassigned_leads![0]!.profile).toEqual({ stage: "qualifying", asked: "budget" });
    expect(fake.rows.sms_unassigned_lead_turns ?? []).toEqual([]);
    await runLeadFollowUps(fake.db, deps);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("two overlapping sweeps cannot both send: the second finds the row already changed", async () => {
    const fake = db([{ id: "lead-10", quietMs: 30 * HOUR }]);
    const { send, deps } = harness();
    // The second sweep read the row before the first claimed it: simulate by running both over the same snapshot.
    const [a, b] = await Promise.all([runLeadFollowUps(fake.db, deps), runLeadFollowUps(fake.db, deps)]);
    expect(a.nudged24 + b.nudged24).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("texts a no-match lead once when a fitting room opens", async () => {
    const fits: MockProperty[] = [publicListingProjection(storedListing("prop-new", { manager: "m", neighborhood: "University District", beds: 4, rent: 800, street: "1 Elm St", name: "New House" }))];
    const profile: LeadProfile = {
      stage: "no_match", budgetMax: 1000, area: "University District", bathroom: "any", furnished: "any", household: 1, leaseMonths: 6, moveInDate: "2026-11-01",
    };
    const fake = db([{ id: "lead-11", quietMs: 30 * HOUR, profile }]);
    const { send, deps } = harness({ listings: async () => fits });
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ newMatch: 1, nudged24: 0 });
    expect(send.mock.calls[0]![1].body).toContain("A room that fits just opened.");
    expect(send.mock.calls[0]![1].body).toContain("https://proplane.ai/rent/listings/prop-new");
    expect(fake.rows.sms_unassigned_leads![0]!.profile).toMatchObject({ stage: "offered", asked: "pick" });
    await runLeadFollowUps(fake.db, deps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves a no-match lead alone while nothing fits", async () => {
    const profile: LeadProfile = { stage: "no_match", budgetMax: 200, area: "Tacoma", bathroom: "any", furnished: "any", household: 1, leaseMonths: 6, moveInDate: "2026-11-01" };
    const fake = db([{ id: "lead-12", quietMs: 30 * HOUR, profile }]);
    const { send, deps } = harness();
    expect(await runLeadFollowUps(fake.db, deps)).toMatchObject({ newMatch: 0, nudged24: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
