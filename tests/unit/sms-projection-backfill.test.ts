import { describe, expect, it } from "vitest";

const backfillUrl = new URL("../../scripts/backfill-sms-projection.mjs", import.meta.url);
const {
  parseArgs,
  normalizeSmsPhone,
  buildSmsIdentity,
  isExplicitNoticeOriginal,
  isProjectionNoticeMarker,
  shouldBindLegacyThreadAlias,
  splitSourceIdentity,
  sourceNamespace,
  feedMayRunAfter,
  eventMatchesStored,
  retainedHistoricalUnplacedIdentity,
  isCleanCutoverInventory,
} = await import(backfillUrl.href);

describe("SMS projection backfill safety", () => {
  it("defaults to a bounded dry run and requires a cursor file before apply", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, batchSize: 100, maxPages: 10, cursorFile: null });
    expect(() => parseArgs(["--apply"])).toThrow("--apply requires --cursor-file");
    expect(parseArgs(["--apply", "--cursor-file", "/tmp/sms-cursor.json", "--batch-size", "20"]))
      .toMatchObject({ apply: true, batchSize: 20, cursorFile: "/tmp/sms-cursor.json" });
    expect(() => parseArgs(["--batch-size", "1000"])).toThrow("--batch-size must be 1..500");
  });

  it("normalizes phone identities without merging different verified users", () => {
    expect(normalizeSmsPhone("(415) 555-0123")).toBe("+14155550123");
    expect(buildSmsIdentity({ role: "prospect", phone: "4155550123", sourceId: "SM-1" }))
      .toEqual({ identityKind: "phone", identityKey: "phone:+14155550123" });
    expect(buildSmsIdentity({ role: "unknown", phone: "4155550123", sourceId: "SM-1" }).identityKey)
      .not.toBe(buildSmsIdentity({ role: "unknown", phone: "4155550123", sourceId: "SM-2" }).identityKey);
    expect(buildSmsIdentity({ role: "resident", userId: "user-a", phone: "4155550123" }).identityKey)
      .not.toBe(buildSmsIdentity({ role: "resident", userId: "user-b", phone: "4155550123" }).identityKey);
  });

  it("accepts only explicitly tagged original notice events, never aggregate text", () => {
    expect(isExplicitNoticeOriginal({
      sourceType: "provider_sms", providerSid: "SM-1", body: "original",
      at: "2026-09-25T12:00:00.000Z", direction: "inbound",
    })).toBe(true);
    expect(isExplicitNoticeOriginal({ id: "resident_SM-1", body: "generated brief with\nmultiple messages" })).toBe(false);
  });

  it("binds a legacy SMS URL only when every visible message is a unique exact marker", () => {
    const marker = {
      sourceNamespace: "twilio:owner:AC123", sourceEventId: "SM123", ownerManagerUserId: "owner",
      counterpartyRole: "prospect", workLineId: "line", occurredAt: "2026-09-25T12:00:00.000Z",
      bodySha256: "a".repeat(64),
    };
    expect(isProjectionNoticeMarker(marker)).toBe(true);
    const eligible = {
      markedCount: 1, projectionMarkerCount: 1,
      messages: [{ originalSmsEvent: marker }], allMarkersBound: true, conversationIds: ["conversation-a"],
    };
    expect(shouldBindLegacyThreadAlias(eligible)).toBe(true);
    expect(shouldBindLegacyThreadAlias({ ...eligible, messages: [{ body: "separate annotation" }] })).toBe(false);
    expect(shouldBindLegacyThreadAlias({ ...eligible, conversationIds: ["conversation-a", "conversation-b"] })).toBe(false);
    expect(shouldBindLegacyThreadAlias({ ...eligible, allMarkersBound: false })).toBe(false);
  });

  it("keeps provider event ids separate from importer source row ids", () => {
    expect(splitSourceIdentity({ id: "row-uuid", message_sid: "SM-123" }, "inbound_sms_log"))
      .toEqual({ sourceRowId: "row-uuid", providerEventId: "SM-123", annotationEventId: "" });
    expect(splitSourceIdentity({ source_message_id: "SM-456" }, "prospect_sms_ingress"))
      .toEqual({ sourceRowId: "SM-456", providerEventId: "SM-456", annotationEventId: "" });
    expect(splitSourceIdentity({ id: "row-uuid", message_sid: "voice:CA123:user:abc" }, "manager_sms_messages"))
      .toEqual({ sourceRowId: "row-uuid", providerEventId: "", annotationEventId: "voice:CA123:user:abc" });
    expect(sourceNamespace("owner", "voice:CA123:user:abc", "manager_sms_messages")).toBe("voice:owner");
    expect(sourceNamespace("owner", "SM123", "manager_sms_messages")).toMatch(/^twilio:owner:/);
  });

  it("blocks lower-priority feeds while a higher-priority feed has more pages", () => {
    expect(feedMayRunAfter([{ source: "prospect_sms_ingress", hasMore: true }])).toBe(false);
    expect(feedMayRunAfter([{ source: "prospect_sms_ingress", hasMore: false }])).toBe(true);
  });

  it("requires exact time, role, owner and line agreement for an existing mapping", () => {
    const event = {
      ownerManagerUserId: "owner", counterpartyRole: "prospect", workLineId: "line",
      identityKind: "phone", identityKey: "phone:+14155550123", counterpartyUserId: null, counterpartyPhone: "+14155550123",
      body: "hello", direction: "inbound", occurredAt: "2026-09-25T12:00:00.000Z",
      fromPhone: "+14155550123", toPhone: "+14155550999", sourceRef: { table: "inbound_sms_log", id: "row" },
    };
    const existing = {
      owner_manager_user_id: "owner", counterparty_role: "prospect", work_line_id: "line",
      identity_kind: "phone", identity_key: "phone:+14155550123", counterparty_user_id: null,
      body: "hello", direction: "inbound", occurred_at: event.occurredAt,
      from_phone: event.fromPhone, to_phone: event.toPhone, source_ref: event.sourceRef,
    };
    expect(eventMatchesStored(existing, event)).toBe(true);
    expect(eventMatchesStored({ ...existing, occurred_at: "2026-09-25T12:00:01.000Z" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, occurred_at: "2026-09-25T12:00:00.000001Z" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, occurred_at: "2026-09-25 08:00:00-04:00" }, event)).toBe(true);
    expect(eventMatchesStored({ ...existing, occurred_at: "2026-02-30T12:00:00Z" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, work_line_id: "other-line" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, identity_key: "user:person-a", identity_kind: "user", counterparty_user_id: "person-a" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, counterparty_role: "resident" }, event)).toBe(false);
    expect(eventMatchesStored({ ...existing, identity_kind: "unresolved", identity_key: "unresolved:SM-1" }, {
      ...event, identityKind: "user", identityKey: "user:person-a", counterpartyUserId: "person-a",
    }, { allowIdentityEnrichment: true })).toBe(true);
    expect(eventMatchesStored({ ...existing, identity_kind: "user", identity_key: "user:person-a", counterparty_user_id: "person-a" }, {
      ...event, identityKind: "user", identityKey: "user:person-b", counterpartyUserId: "person-b",
    }, { allowIdentityEnrichment: true })).toBe(false);
    expect(eventMatchesStored({ ...existing, identity_kind: "phone", identity_key: "phone:+14155550123", counterparty_phone: "+14155550123" }, {
      ...event, identityKind: "user", identityKey: "user:person-a", counterpartyUserId: "person-a",
    }, { allowIdentityEnrichment: true })).toBe(true);
    expect(eventMatchesStored({ ...existing, identity_kind: "phone", identity_key: "phone:+14155550123", counterparty_phone: "+14155550123" }, {
      ...event, counterpartyPhone: "+14155550124", identityKind: "user", identityKey: "user:person-a", counterpartyUserId: "person-a",
    }, { allowIdentityEnrichment: true })).toBe(false);
  });

  it("does not call an incomplete or unresolved inventory clean", () => {
    const empty = { unresolvedLine: 0, unresolvedNotice: 0, unresolvedRelay: 0, integrityMismatch: 0, errors: 0 };
    expect(isCleanCutoverInventory([{ hasMore: false, counts: empty }])).toBe(true);
    expect(isCleanCutoverInventory([{ hasMore: true, counts: empty }])).toBe(false);
    expect(isCleanCutoverInventory([{ hasMore: false, counts: { ...empty, unresolvedNotice: 1 } }])).toBe(false);
  });

  it("retains only an exact read-only historical singleton when its work line is unproven", () => {
    const event = {
      ownerManagerUserId: "owner", counterpartyRole: "resident", workLineId: "",
      identityKind: "user", identityKey: "user:person-a", counterpartyUserId: "person-a",
      body: "original", direction: "inbound", occurredAt: "2026-09-25T12:00:00.000Z",
      fromPhone: "+14155550123", toPhone: "+14155550999",
      sourceRef: { table: "manager_sms_messages", id: "row-1" },
    };
    const existing = {
      owner_manager_user_id: "owner", counterparty_role: "resident", work_line_id: "synthetic-line",
      identity_kind: "unresolved", identity_key: "legacy-unplaced", counterparty_user_id: "person-a",
      body: "original", direction: "inbound", occurred_at: event.occurredAt,
      from_phone: event.fromPhone, to_phone: event.toPhone,
      source_ref: { table: "manager_sms_messages", id: "row-1", historical: true },
      metadata: { historical: true, sendDisabled: true }, event_count: 1,
    };
    const candidate = { line: null, sourceTable: "manager_sms_messages", sourceRowId: "row-1" };
    expect(retainedHistoricalUnplacedIdentity(existing, event, candidate)).toBe(true);
    expect(retainedHistoricalUnplacedIdentity({ ...existing, body: "changed" }, event, candidate)).toBe(false);
    expect(retainedHistoricalUnplacedIdentity({ ...existing, counterparty_user_id: "person-b" }, event, candidate)).toBe(false);
    expect(retainedHistoricalUnplacedIdentity({ ...existing, metadata: { historical: true, sendDisabled: false } }, event, candidate)).toBe(false);
    expect(retainedHistoricalUnplacedIdentity({ ...existing, source_ref: { ...existing.source_ref, id: "row-2" } }, event, candidate)).toBe(false);
    expect(retainedHistoricalUnplacedIdentity({ ...existing, event_count: 2 }, event, candidate)).toBe(false);
  });
});
