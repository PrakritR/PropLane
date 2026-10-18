// Consent to the house chat: server-owned (phone and teams come from the signed-in account), a verified
// phone is required, nothing is recorded while the line is per-workspace, and the offer shows only when chat is on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, HOUSE, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
const found = vi.hoisted(() => ({ list: [] as { workspaceId: string; propertyId: string | null }[] }));
vi.mock("@/lib/one-number/router-lookups.server", () => ({ findResidentCandidates: vi.fn(async () => found.list) }));

import { houseChatOfferAvailable, recordResidentHouseChatChoice } from "@/lib/house-groups/consent.server";
import { HOUSE_CHAT_CONSENT_WORDING } from "@/lib/house-groups/consent";

const profile = (over: Record<string, unknown> = {}) => ({ id: "u1", phone: "+12065550101", phone_verified_at: "2026-10-01T00:00:00Z", ...over });

beforeEach(() => {
  found.list = [{ workspaceId: WS, propertyId: HOUSE }];
});

describe("recordResidentHouseChatChoice", () => {
  it("records a yes against the account's verified phone for each team on the shared line", async () => {
    const { db, rows } = fakeDb({ profiles: [profile()] });
    const result = await recordResidentHouseChatChoice(db, "u1", true);
    expect(result.ok).toBe(true);
    expect(rows.house_group_preferences).toEqual([
      expect.objectContaining({ workspace_id: WS, phone_key: "2065550101", opted_out_of_group: false, consent_source: "lease_signature", consent_at: expect.any(String) }),
    ]);
  });

  it("records a no as the same state 'leave group' sets", async () => {
    const { db, rows } = fakeDb({ profiles: [profile()] });
    await recordResidentHouseChatChoice(db, "u1", false);
    expect(rows.house_group_preferences[0]).toMatchObject({ opted_out_of_group: true });
  });

  it("records nothing for an unverified phone, for a team that is not on the shared line, or for a stranger", async () => {
    const unverified = fakeDb({ profiles: [profile({ phone_verified_at: null })] });
    expect((await recordResidentHouseChatChoice(unverified.db, "u1", true)).ok).toBe(false);
    const perWorkspace = fakeDb({ profiles: [profile()], sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    expect((await recordResidentHouseChatChoice(perWorkspace.db, "u1", true)).ok).toBe(false);
    expect(perWorkspace.rows.house_group_preferences ?? []).toEqual([]);
    const stranger = fakeDb({ profiles: [profile()] });
    expect((await recordResidentHouseChatChoice(stranger.db, "nobody", true)).ok).toBe(false);
  });
});

describe("houseChatOfferAvailable", () => {
  it("offers the checkbox only when the resident's team has house chat on", async () => {
    expect(await houseChatOfferAvailable(fakeDb({ profiles: [profile()] }).db, "u1")).toBe(true);
    const off = fakeDb({ profiles: [profile()], house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] });
    expect(await houseChatOfferAvailable(off.db, "u1")).toBe(false);
    found.list = [];
    expect(await houseChatOfferAvailable(fakeDb({ profiles: [profile()] }).db, "u1")).toBe(false);
  });
});

describe("consent wording", () => {
  it("says what the resident is agreeing to, in plain words", () => {
    expect(HOUSE_CHAT_CONSENT_WORDING).toContain("Housemates will see my number");
    expect(HOUSE_CHAT_CONSENT_WORDING).toContain("PropLane reads messages");
    expect(HOUSE_CHAT_CONSENT_WORDING).toContain("LEAVE GROUP");
  });
});
