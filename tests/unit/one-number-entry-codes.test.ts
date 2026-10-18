// Entry codes: shape, reserved words, suggestion, global uniqueness, and the workspace fence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEAD_CONSTRAINTS, leadFakeDb } from "../helpers/lead-fake-db";

vi.mock("server-only", () => ({}));

import {
  ENTRY_CODE_PATTERN,
  RESERVED_ENTRY_CODES,
  entryCodeCallToAction,
  entryCodeCandidates,
  entryCodeSmsLink,
  normalizeEntryCode,
  parseStreet,
  validateEntryCode,
} from "@/lib/one-number/entry-codes";
import {
  MAX_ACTIVE_CODES_PER_PROPERTY,
  createEntryCode,
  listEntryCodes,
  loadDoorCardTextCode,
  setEntryCodeActive,
  suggestEntryCode,
} from "@/lib/one-number/entry-codes.server";

describe("entry code shape", () => {
  it("accepts upper-case letters and digits, 3 to 16 long, and upper-cases what it is given", () => {
    expect(validateEntryCode("brooklyn5")).toEqual({ ok: true, code: "BROOKLYN5" });
    expect(validateEntryCode(" 8thave47 ")).toEqual({ ok: true, code: "8THAVE47" });
    expect(ENTRY_CODE_PATTERN.test("AB")).toBe(false);
    expect(validateEntryCode("AB")).toEqual({ ok: false, error: "invalid_format" });
    expect(validateEntryCode("A".repeat(17))).toEqual({ ok: false, error: "invalid_format" });
    expect(validateEntryCode("BROOK-LYN")).toEqual({ ok: false, error: "invalid_format" });
    expect(validateEntryCode("BROOK LYN")).toEqual({ ok: false, error: "invalid_format" });
    expect(validateEntryCode(null)).toEqual({ ok: false, error: "invalid_format" });
    expect(normalizeEntryCode(42)).toBe("");
  });

  it("refuses every reserved carrier and product word, in any case", () => {
    for (const word of ["STOP", "START", "HELP", "HUMAN", "YES", "NO", "INFO", "CANCEL", "END", "QUIT", "UNSUBSCRIBE", "UNSTOP", "STOPALL", "AGENT"]) {
      expect(RESERVED_ENTRY_CODES.has(word)).toBe(true);
      // NO and YES are under 3 letters / reserved: either way they are not accepted.
      expect(validateEntryCode(word).ok).toBe(false);
      expect(validateEntryCode(word.toLowerCase()).ok).toBe(false);
    }
    expect(validateEntryCode("stop")).toEqual({ ok: false, error: "reserved" });
    expect(validateEntryCode("human")).toEqual({ ok: false, error: "reserved" });
  });

  it("refuses an everyday word and an all-digit code that would hijack an ordinary text", () => {
    expect(validateEntryCode("HELLO")).toEqual({ ok: false, error: "reserved" });
    expect(validateEntryCode("ROOM")).toEqual({ ok: false, error: "reserved" });
    expect(validateEntryCode("1200")).toEqual({ ok: false, error: "needs_letter" });
  });
});

describe("suggesting a code from the house", () => {
  it("builds the street word plus the first digit(s): BROOKLYN5 and 8THAVE47", () => {
    expect(entryCodeCandidates({ address: "5259 Brooklyn Ave NE, Seattle, WA" })[0]).toBe("BROOKLYN5");
    expect(entryCodeCandidates({ address: "4709A 8th Ave, Seattle, WA" })[0]).toBe("8THAVE47");
    expect(parseStreet("4709A 8th Ave NE")).toMatchObject({ number: "4709A", digits: "4709", word: "8THAVE" });
  });

  it("drops directions, unit markers and street suffixes, and only ever proposes valid codes", () => {
    expect(parseStreet("12 NE 45th St Apt 3")?.word).toBe("45THST");
    const list = entryCodeCandidates({ address: "5259 Brooklyn Ave NE, Seattle", label: "Brooklyn House" });
    expect(list.length).toBeGreaterThan(3);
    for (const code of list) expect(validateEntryCode(code).ok).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it("falls back to the house name when there is no street number", () => {
    expect(entryCodeCandidates({ address: "", label: "The Ballard House" })[0]).toBe("THEBALLARDHO");
  });

  it("writes the call to action and the prefilled-text link from the shared number", () => {
    expect(entryCodeCallToAction("BROOKLYN5", "+12065550100")).toBe("Text BROOKLYN5 to (206) 555-0100");
    expect(entryCodeSmsLink("BROOKLYN5", "+12065550100")).toBe("sms:+12065550100?&body=BROOKLYN5");
    expect(entryCodeCallToAction("BROOKLYN5", null)).toBeNull();
    expect(entryCodeSmsLink("BROOKLYN5", "")).toBeNull();
  });
});

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seed() {
  return leadFakeDb(
    {
      manager_property_records: [
        { id: "prop-a", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { address: "5259 Brooklyn Ave NE, Seattle", buildingName: "Brooklyn House" } },
        { id: "prop-a2", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { address: "4709A 8th Ave, Seattle", buildingName: "8th Ave" } },
        { id: "prop-b", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { address: "9 Pine St, Seattle", buildingName: "Pine House" } },
        { id: "prop-legacy", workspace_id: null, manager_user_id: OWNER_A, status: "live", property_data: { address: "77 Elm St, Seattle" } },
      ],
      sms_entry_codes: [
        { code: "PINE9", workspace_id: WS_B, owner_user_id: OWNER_B, property_id: "prop-b", label: "Pine House", active: true, created_at: "2026-10-01T00:00:00Z" },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

describe("creating a code", () => {
  let fake: ReturnType<typeof seed>;
  const scopeA = { workspaceId: WS_A, ownerUserId: OWNER_A, actorUserId: OWNER_A };
  beforeEach(() => {
    fake = seed();
  });

  it("takes the suggestion when no code is given, and stores it against the workspace and house", async () => {
    const made = await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a" });
    expect(made).toMatchObject({ ok: true, record: { code: "BROOKLYN5", workspaceId: WS_A, propertyId: "prop-a", active: true } });
    expect(fake.rows.sms_entry_codes!.find((r) => r.code === "BROOKLYN5")).toMatchObject({ workspace_id: WS_A, owner_user_id: OWNER_A, property_id: "prop-a", created_by: OWNER_A });
  });

  it("is globally unique: another workspace's code is taken, with no hint whose it is", async () => {
    const made = await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "pine9" });
    expect(made).toEqual({ ok: false, error: "taken" });
    const again = await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "BROOKLYN5" });
    expect(again.ok).toBe(true);
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a2", code: "BROOKLYN5" })).toEqual({ ok: false, error: "taken" });
  });

  it("skips a suggestion another house already holds", async () => {
    fake.rows.sms_entry_codes!.push({ code: "BROOKLYN5", workspace_id: WS_B, owner_user_id: OWNER_B, property_id: "prop-b", active: false });
    expect(await suggestEntryCode(fake.db, { workspaceId: WS_A, ownerUserId: OWNER_A }, "prop-a")).toBe("BROOKLYN52");
  });

  it("rejects a reserved word, a bad shape and an all-digit code before touching the table", async () => {
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "STOP" })).toEqual({ ok: false, error: "reserved" });
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "no" })).toEqual({ ok: false, error: "invalid_format" });
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "123456" })).toEqual({ ok: false, error: "needs_letter" });
    expect(fake.rows.sms_entry_codes).toHaveLength(1);
  });

  it("only for a house that is this workspace's own", async () => {
    // Workspace A cannot mint a code on workspace B's house, and an unknown id is the same answer.
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-b", code: "MINE1" })).toEqual({ ok: false, error: "property_not_found" });
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "nope", code: "MINE1" })).toEqual({ ok: false, error: "property_not_found" });
    expect(fake.rows.sms_entry_codes!.some((r) => r.code === "MINE1")).toBe(false);
    // A legacy row with no workspace stamp belongs to its owner's workspace, and to nobody else's.
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-legacy", code: "ELM77" })).toMatchObject({ ok: true });
    expect(await createEntryCode(fake.db, { workspaceId: WS_B, ownerUserId: OWNER_B, actorUserId: OWNER_B, propertyId: "prop-legacy", code: "ELM78" })).toEqual({ ok: false, error: "property_not_found" });
  });

  it("caps live codes per house", async () => {
    for (let i = 0; i < MAX_ACTIVE_CODES_PER_PROPERTY; i += 1) {
      expect((await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: `FLYER${i}` })).ok).toBe(true);
    }
    expect(await createEntryCode(fake.db, { ...scopeA, propertyId: "prop-a", code: "FLYER9" })).toEqual({ ok: false, error: "too_many" });
  });
});

describe("one workspace never reaches another's codes", () => {
  it("lists only the caller's workspace", async () => {
    const fake = seed();
    await createEntryCode(fake.db, { workspaceId: WS_A, ownerUserId: OWNER_A, actorUserId: OWNER_A, propertyId: "prop-a", code: "MINE1" });
    expect((await listEntryCodes(fake.db, { workspaceId: WS_A })).map((c) => c.code)).toEqual(["MINE1"]);
    expect((await listEntryCodes(fake.db, { workspaceId: WS_B })).map((c) => c.code)).toEqual(["PINE9"]);
    expect(await listEntryCodes(fake.db, { workspaceId: WS_A, propertyId: "prop-b" })).toEqual([]);
  });

  it("cannot deactivate or reactivate another workspace's code: it reads as not found", async () => {
    const fake = seed();
    expect(await setEntryCodeActive(fake.db, { workspaceId: WS_A, code: "PINE9", active: false })).toEqual({ ok: false, error: "not_found" });
    expect(fake.rows.sms_entry_codes!.find((r) => r.code === "PINE9")?.active).toBe(true);
    expect(await setEntryCodeActive(fake.db, { workspaceId: WS_A, code: "NOSUCH", active: false })).toEqual({ ok: false, error: "not_found" });
    expect(await setEntryCodeActive(fake.db, { workspaceId: WS_B, code: "pine9", active: false })).toMatchObject({ ok: true, record: { active: false } });
    expect(fake.rows.sms_entry_codes!.find((r) => r.code === "PINE9")?.active).toBe(false);
  });

  it("a co-manager without the house cannot toggle its code", async () => {
    const fake = seed();
    await createEntryCode(fake.db, { workspaceId: WS_A, ownerUserId: OWNER_A, actorUserId: OWNER_A, propertyId: "prop-a", code: "MINE1" });
    expect(await setEntryCodeActive(fake.db, { workspaceId: WS_A, code: "MINE1", active: false, allowedPropertyIds: ["prop-a2"] })).toEqual({ ok: false, error: "not_found" });
    expect(await setEntryCodeActive(fake.db, { workspaceId: WS_A, code: "MINE1", active: false, allowedPropertyIds: ["prop-a"] })).toMatchObject({ ok: true });
  });
});

describe("the door card's text code", () => {
  const config = (mode: string, number: string | null) => ({ sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: number }] });

  it("prints only on the shared line, only a live code, only for the house's own owner", async () => {
    const live = leadFakeDb({
      ...config("shared", "+12065550100"),
      sms_entry_codes: [
        { code: "OLD1", owner_user_id: OWNER_A, property_id: "prop-a", active: false, created_at: "2026-10-01" },
        { code: "BROOKLYN5", owner_user_id: OWNER_A, property_id: "prop-a", active: true, created_at: "2026-10-02" },
      ],
    });
    expect(await loadDoorCardTextCode(live.db, { propertyId: "prop-a", ownerUserId: OWNER_A })).toEqual({
      code: "BROOKLYN5",
      callToAction: "Text BROOKLYN5 to (206) 555-0100",
      smsLink: "sms:+12065550100?&body=BROOKLYN5",
    });
    expect(await loadDoorCardTextCode(live.db, { propertyId: "prop-a", ownerUserId: OWNER_B })).toBeNull();

    const perWorkspace = leadFakeDb({ ...config("per_workspace", null), sms_entry_codes: live.rows.sms_entry_codes });
    expect(await loadDoorCardTextCode(perWorkspace.db, { propertyId: "prop-a", ownerUserId: OWNER_A })).toBeNull();
    const noNumber = leadFakeDb({ ...config("shared", null), sms_entry_codes: live.rows.sms_entry_codes });
    expect(await loadDoorCardTextCode(noNumber.db, { propertyId: "prop-a", ownerUserId: OWNER_A })).toBeNull();
  });
});
