import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SMS keyword router behind the public "Text to tour" / "Text to apply"
 * listing CTAs. The behaviors under test are the ones the feature's safety
 * rests on:
 *
 * 1. A tour-intent text creates exactly ONE pending tour inquiry (the same
 *    record shapes the web booking page writes), and repeating the intent
 *    reminds instead of duplicating.
 * 2. An apply-intent text replies with the real wizard link and creates NO
 *    rows, so it cannot duplicate anything.
 * 3. Once a human manager has replied in the thread (any outbound
 *    `manager_sms_messages` row whose source is not "automated"), the router
 *    goes silent — handled with no body, so default handling is skipped too.
 * 4. STOP records the opt-out and stays silent; HELP identifies the business
 *    and how to opt out; an opted-out number is never auto-replied to.
 * 5. A first contact that matches nothing still gets a greeting that
 *    identifies the business with a STOP footer.
 */

const isPhoneOptedOutMock = vi.fn(async () => false);
const recordOptInMock = vi.fn(async () => undefined);
const recordOptOutMock = vi.fn(async () => undefined);
vi.mock("@/lib/sms-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-consent")>();
  return {
    ...actual,
    isPhoneOptedOut: (...args: unknown[]) => isPhoneOptedOutMock(...(args as [])),
    recordOptIn: (...args: unknown[]) => recordOptInMock(...(args as [])),
    recordOptOut: (...args: unknown[]) => recordOptOutMock(...(args as [])),
  };
});

vi.mock("@/lib/claw-leasing-bot.server", () => ({
  publicAppOrigin: () => "https://prop-lane.space",
}));

vi.mock("@/lib/tour-inquiry.server", () => ({
  INQUIRIES_RECORD_ID: "axis_admin_partner_inquiries_v1",
}));

const loadManagerTourBlocksMock = vi.fn(async () => [] as { start: string; end: string; slotKey?: string }[]);
const proposeTourConfirmationMock = vi.fn(async () => ({ proposed: false as const }));
vi.mock("@/lib/tour-proposal.server", () => ({
  loadManagerTourBlocks: (...args: unknown[]) => loadManagerTourBlocksMock(...(args as [])),
  proposeTourConfirmation: (...args: unknown[]) => proposeTourConfirmationMock(...(args as [])),
}));

const notifyManagerTourRequestMock = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: (...args: unknown[]) => notifyManagerTourRequestMock(...(args as [])),
}));

vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: vi.fn(async () => ({ proposeTourConfirmations: false })),
}));

vi.mock("@/lib/manager-property-links", () => ({
  buildManagerApplyUrl: (
    origin: string,
    p: { propertyId: string; phone?: string; bundleId?: string },
  ) =>
    `${origin}/rent/apply?propertyId=${p.propertyId}` +
    (p.phone ? `&phone=${encodeURIComponent(p.phone)}` : "") +
    (p.bundleId ? `&bundle=${p.bundleId}` : ""),
  buildManagerTourUrl: (origin: string, id: string) => `${origin}/rent/tours-contact?propertyId=${id}`,
  buildManagerListingUrl: (origin: string, id: string) => `${origin}/rent/listings/${id}`,
}));

/* ------------------------------------------------------------------ */
/* Fake service-role db                                                */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const state = {
  propertyRecords: [] as Row[],
  scheduleRecords: new Map<string, Row>(),
  smsMessages: [] as Row[],
  /** Makes the inquiries-singleton read fail, the way a transient outage would. */
  singletonReadError: false,
  /** Ordered log of portal_schedule_records writes, so ordering can be asserted. */
  ops: [] as string[],
  /** Fires before each singleton read, so a concurrent writer can be simulated. */
  onSingletonRead: null as ((readIndex: number) => void) | null,
  singletonReads: 0,
  /** Makes every portal_schedule_records upsert fail. */
  writeError: false,
};

function rowsForTable(table: string): Row[] {
  if (table === "manager_property_records") return state.propertyRecords;
  if (table === "portal_schedule_records") return [...state.scheduleRecords.values()];
  if (table === "manager_sms_messages") return state.smsMessages;
  return [];
}

function makeQuery(table: string) {
  const filters: { op: "eq" | "neq" | "in"; col: string; val: unknown }[] = [];
  let mode: "select" | "delete" = "select";

  const matches = (row: Row): boolean =>
    filters.every((f) => {
      const value = row[f.col];
      if (f.op === "eq") return value === f.val;
      if (f.op === "neq") return value !== f.val;
      return Array.isArray(f.val) && (f.val as unknown[]).includes(value);
    });

  const run = () => rowsForTable(table).filter(matches);

  const exec = () => {
    if (mode === "delete" && table === "portal_schedule_records") {
      const doomed = run();
      state.ops.push(`delete:${doomed.map((row) => String(row.id)).join(",")}`);
      for (const row of doomed) state.scheduleRecords.delete(String(row.id));
      return { data: null, error: null };
    }
    return { data: run(), error: null };
  };

  const api = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (col: string, val: unknown) => {
      filters.push({ op: "eq", col, val });
      return api;
    },
    neq: (col: string, val: unknown) => {
      filters.push({ op: "neq", col, val });
      return api;
    },
    in: (col: string, val: unknown) => {
      filters.push({ op: "in", col, val });
      return api;
    },
    delete: () => {
      mode = "delete";
      return api;
    },
    maybeSingle: async () => {
      if (table === "portal_schedule_records") {
        if (state.singletonReadError) return { data: null, error: { message: "read failed" } };
        state.singletonReads += 1;
        state.onSingletonRead?.(state.singletonReads);
      }
      const rows = run();
      return { data: rows[0] ?? null, error: null };
    },
    upsert: async (records: Row | Row[]) => {
      if (table === "portal_schedule_records") {
        if (state.writeError) return { error: { message: "write failed" } };
        const list = Array.isArray(records) ? records : [records];
        state.ops.push(`upsert:${list.map((record) => String(record.id)).join(",")}`);
        for (const record of list) state.scheduleRecords.set(String(record.id), record);
      }
      return { error: null };
    },
    then: (resolve: (v: { data: Row[]; error: null } | { data: null; error: null }) => unknown) =>
      resolve(exec() as never),
  };
  return api;
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (table: string) => makeQuery(table) }),
}));

import { firstContactMenuReply, routeInboundSms, type InboundSmsContext } from "@/lib/sms-intent-router";

const MANAGER_ID = "mgr-user-1";
const PROSPECT_PHONE = "+12065550123";
const INQUIRIES_ID = "axis_admin_partner_inquiries_v1";

function ctx(body: string, overrides?: Partial<InboundSmsContext>): InboundSmsContext {
  return {
    fromPhone: PROSPECT_PHONE,
    toPhone: "+12535550001",
    body,
    managerId: MANAGER_ID,
    conversationId: `${MANAGER_ID}:prospect:2065550123`,
    isFirstMessageInConversation: true,
    ...overrides,
  };
}

function seedListing(overrides?: Partial<Row>) {
  state.propertyRecords.push({
    id: "mgr-maple-house-1",
    status: "live",
    manager_user_id: MANAGER_ID,
    property_data: { buildingName: "Maple House", rentLabel: "$1,050/mo" },
    ...overrides,
  });
}

function inquiryPayload(): Row[] {
  const singleton = state.scheduleRecords.get(INQUIRIES_ID);
  const rowData = singleton?.row_data as { payload?: Row[] } | undefined;
  return rowData?.payload ?? [];
}

function setInquiryPayload(payload: Row[]) {
  state.scheduleRecords.set(INQUIRIES_ID, {
    id: INQUIRIES_ID,
    record_type: INQUIRIES_ID,
    row_data: { id: INQUIRIES_ID, recordType: INQUIRIES_ID, payload },
  });
}

beforeEach(() => {
  state.propertyRecords = [];
  state.scheduleRecords = new Map();
  state.smsMessages = [];
  state.singletonReadError = false;
  state.ops = [];
  state.onSingletonRead = null;
  state.singletonReads = 0;
  state.writeError = false;
  isPhoneOptedOutMock.mockClear().mockResolvedValue(false);
  recordOptInMock.mockClear();
  recordOptOutMock.mockClear();
  loadManagerTourBlocksMock.mockClear().mockResolvedValue([]);
  notifyManagerTourRequestMock.mockClear();
  proposeTourConfirmationMock.mockClear();
  // A fixed instant — 10:00 AM Pacific (PDT, UTC-7) — so the 9-5 default tour
  // grid yields deterministic offered slots.
  vi.useFakeTimers({ now: new Date("2026-08-04T17:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compliance controls", () => {
  it("STOP records the opt-out and replies nothing (Twilio sends the confirmation)", async () => {
    const result = await routeInboundSms(ctx("STOP"));
    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toBeUndefined();
    expect(recordOptOutMock).toHaveBeenCalledTimes(1);
    expect(recordOptOutMock.mock.calls[0]?.[1]).toBe(PROSPECT_PHONE);
  });

  it("HELP identifies the business and how to opt out", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("HELP"));
    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("Maple House");
    expect(result.autoReplyBody).toContain("PropLane");
    expect(result.autoReplyBody).toContain("Reply STOP to opt out");
  });

  it("an opted-out number is never auto-replied to — even for tour intent", async () => {
    seedListing();
    isPhoneOptedOutMock.mockResolvedValue(true);
    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(result).toEqual({ handled: true });
    expect(inquiryPayload()).toHaveLength(0);
  });

  it("START (and a bare YES after a STOP) opts the number back in", async () => {
    const started = await routeInboundSms(ctx("START"));
    expect(started.handled).toBe(true);
    expect(started.autoReplyBody).toContain("opted back in");
    expect(recordOptInMock).toHaveBeenCalledTimes(1);

    isPhoneOptedOutMock.mockResolvedValue(true);
    const resumed = await routeInboundSms(ctx("yes"));
    expect(resumed.autoReplyBody).toContain("opted back in");
    expect(recordOptInMock).toHaveBeenCalledTimes(2);
  });
});

describe("human takeover suppression", () => {
  it("goes silent once any human-authored outbound exists in the thread", async () => {
    seedListing();
    state.smsMessages.push({
      id: "m1",
      manager_user_id: MANAGER_ID,
      resident_phone: PROSPECT_PHONE,
      direction: "outbound",
      source: "work_number",
    });
    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(result).toEqual({ handled: true });
    expect(inquiryPayload()).toHaveLength(0);
  });

  it("automated-only outbound history does NOT suppress", async () => {
    seedListing();
    state.smsMessages.push({
      id: "m1",
      manager_user_id: MANAGER_ID,
      resident_phone: PROSPECT_PHONE,
      direction: "outbound",
      source: "automated",
    });
    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(result.autoReplyBody).toContain("Tour request received");
  });
});

describe("text to tour", () => {
  it("creates one real pending tour inquiry with offered windows and a useful reply", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));

    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("Tour request received for Maple House");
    expect(result.autoReplyBody).toMatch(/1\) /);
    expect(result.autoReplyBody).toContain("rent/tours-contact?propertyId=mgr-maple-house-1");
    // First contact → business identification + opt-out footer.
    expect(result.autoReplyBody).toContain("Maple House via PropLane");
    expect(result.autoReplyBody).toContain("Reply STOP to opt out");

    const payload = inquiryPayload();
    expect(payload).toHaveLength(1);
    const row = payload[0]!;
    expect(row.kind).toBe("tour");
    expect(row.status).toBe("pending");
    expect(row.managerUserId).toBe(MANAGER_ID);
    expect(row.propertyId).toBe("mgr-maple-house-1");
    expect(row.phone).toBe(PROSPECT_PHONE);
    expect(row.smsConsent).toBe(true);
    expect(row.source).toBe("sms");
    const windows = row.requestedWindows as { slotKey: string; start: string; end: string }[];
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThanOrEqual(3);
    for (const window of windows) {
      expect(Date.parse(window.end) - Date.parse(window.start)).toBe(30 * 60 * 1000);
    }
    // Standalone per-window records exist for the calendar/conflict readers.
    const standalone = [...state.scheduleRecords.keys()].filter((id) =>
      id.startsWith(`partner_inquiry_request_${row.id}_`),
    );
    expect(standalone).toHaveLength(windows.length);
    // Conversational consent recorded in the ledger.
    expect(recordOptInMock).toHaveBeenCalled();
    expect(recordOptInMock.mock.calls.at(-1)?.[3]).toBe("text-to-tour");
  });

  it("repeating the tour intent does NOT create a second inquiry", async () => {
    seedListing();
    await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(inquiryPayload()).toHaveLength(1);

    const repeat = await routeInboundSms(
      ctx("Hi — I'd like to schedule a tour for Maple House.", { isFirstMessageInConversation: false }),
    );
    expect(repeat.handled).toBe(true);
    expect(repeat.autoReplyBody).toContain("already have a tour request");
    expect(inquiryPayload()).toHaveLength(1);
  });

  it("a slot pick narrows the inquiry to the chosen window and clears the others", async () => {
    seedListing();
    await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    const before = inquiryPayload()[0]!;
    const offered = before.requestedWindows as { slotKey: string }[];
    expect(offered.length).toBeGreaterThan(1);

    state.ops = [];
    const result = await routeInboundSms(ctx("2", { isFirstMessageInConversation: false }));
    expect(result.autoReplyBody).toContain("requested for Maple House");

    const after = inquiryPayload()[0]!;
    const windows = after.requestedWindows as { slotKey: string }[];
    expect(windows).toHaveLength(1);
    expect(windows[0]!.slotKey).toBe(offered[1]!.slotKey);
    const standalone = [...state.scheduleRecords.keys()].filter((id) =>
      id.startsWith(`partner_inquiry_request_${after.id}_`),
    );
    expect(standalone).toEqual([`partner_inquiry_request_${after.id}_0`]);

    // The stale per-window records must be gone BEFORE `_0` is re-pointed at
    // the chosen window, or (manager_user_id, starts_at) is transiently
    // duplicated and the partial unique index rejects the whole write.
    const staleIds = offered.slice(1).map((_, i) => `partner_inquiry_request_${after.id}_${i + 1}`);
    expect(state.ops).toEqual([
      `delete:${staleIds.join(",")}`,
      `upsert:${INQUIRIES_ID},partner_inquiry_request_${after.id}_0`,
    ]);
  });

  it("a failed inquiries read never creates an inquiry — the prospect gets the booking link", async () => {
    seedListing();
    state.singletonReadError = true;

    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));

    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("rent/tours-contact?propertyId=mgr-maple-house-1");
    expect(result.autoReplyBody).not.toContain("Tour request received");
    // Nothing was written, so no other manager's pending inquiries were clobbered.
    expect(state.ops).toHaveLength(0);
    expect(state.scheduleRecords.size).toBe(0);
  });

  it("merges onto the payload as of WRITE time, not the earlier idempotency read", async () => {
    seedListing();
    // A web booking lands between the idempotency read and the singleton write.
    state.onSingletonRead = (readIndex) => {
      if (readIndex !== 2) return;
      setInquiryPayload([
        { id: "web-booking-1", kind: "tour", status: "pending", managerUserId: "mgr-other" },
      ]);
    };

    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(result.autoReplyBody).toContain("Tour request received");

    const payload = inquiryPayload();
    expect(payload).toHaveLength(2);
    expect(payload.map((row) => row.id)).toContain("web-booking-1");
  });

  it("a tour inquiry that races in after the early check is never duplicated", async () => {
    seedListing();
    // The idempotency check passes, then a second inbound (double-tapped CTA,
    // webhook retry) creates the inquiry before this one reaches its write.
    state.onSingletonRead = (readIndex) => {
      if (readIndex !== 2) return;
      setInquiryPayload([
        {
          id: "raced-1",
          kind: "tour",
          status: "pending",
          managerUserId: MANAGER_ID,
          phone: PROSPECT_PHONE,
          propertyTitle: "Maple House",
          requestedWindows: [],
        },
      ]);
    };

    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));

    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("already have a tour request");
    expect(result.autoReplyBody).not.toContain("Tour request received");

    const payload = inquiryPayload();
    expect(payload).toHaveLength(1);
    expect(payload[0]!.id).toBe("raced-1");
    expect(state.ops.filter((op) => op.startsWith("upsert:"))).toHaveLength(0);
    expect(notifyManagerTourRequestMock).not.toHaveBeenCalled();
  });

  it("a follow-up whose write fails is never reported as saved", async () => {
    seedListing();
    await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    state.writeError = true;

    const result = await routeInboundSms(
      ctx("jordan@example.com", { isFirstMessageInConversation: false }),
    );

    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).not.toContain("we'll send your tour confirmation");
    expect(result.autoReplyBody).toContain("didn't save");
    expect(result.autoReplyBody).toContain("rent/tours-contact?propertyId=mgr-maple-house-1");
    expect(inquiryPayload()[0]!.email).toBe("");
  });

  it("a name follow-up fills the inquiry contact instead of creating anything", async () => {
    seedListing();
    await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    const result = await routeInboundSms(ctx("Jordan Rivera", { isFirstMessageInConversation: false }));
    expect(result.autoReplyBody).toContain("Thanks, Jordan Rivera");
    expect(inquiryPayload()).toHaveLength(1);
    expect(inquiryPayload()[0]!.name).toBe("Jordan Rivera");
  });

  it("a non-live listing is never offered a tour — 'live' is the only status the query accepts", async () => {
    // 'unlisted' is a real ManagerPropertyRecordStatus the DB CHECK allows, so
    // this manager reads back with NO tourable listings at all.
    seedListing({ status: "unlisted" });
    const result = await routeInboundSms(ctx("Hi — I'd like to schedule a tour for Maple House."));
    expect(result.autoReplyBody).toContain("No homes are open for tours right now");
    expect(result.autoReplyBody).not.toContain("Maple House via PropLane");
    expect(inquiryPayload()).toHaveLength(0);
  });
});

describe("text to apply", () => {
  it("replies with the prefilled wizard link and creates no rows", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("Hi — I'd like to apply for Maple House."));
    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("/rent/apply?propertyId=mgr-maple-house-1");
    expect(result.autoReplyBody).toContain(encodeURIComponent(PROSPECT_PHONE));
    expect(state.scheduleRecords.size).toBe(0);
  });

  it("repeated apply texts stay idempotent (still no rows)", async () => {
    seedListing();
    await routeInboundSms(ctx("apply"));
    await routeInboundSms(ctx("apply", { isFirstMessageInConversation: false }));
    await routeInboundSms(ctx("apply please", { isFirstMessageInConversation: false }));
    expect(state.scheduleRecords.size).toBe(0);
  });
});

describe("general responses", () => {
  it("an unrecognized first contact gets the identified menu", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("Hey there"));
    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("Reply TOUR");
    expect(result.autoReplyBody).toContain("Reply APPLY");
    expect(result.autoReplyBody).toContain("Reply STOP to opt out");
    expect(result.autoReplyBody).toBe(firstContactMenuReply("Maple House"));
  });

  it("names ONE listing in both the menu and its footer for a multi-listing manager", async () => {
    seedListing();
    seedListing({ id: "mgr-cedar-1", property_data: { buildingName: "Cedar Cottage" } });

    // Resolves the SECOND listing by id hint, so the footer must follow it
    // rather than defaulting to the manager's most recent listing.
    const result = await routeInboundSms(ctx("propertyId=mgr-cedar-1"));

    expect(result.autoReplyBody).toBe(firstContactMenuReply("Cedar Cottage"));
    expect(result.autoReplyBody).not.toContain("Maple House");
  });

  it("a FIRST-contact question falls through to the leasing agent, not the menu", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("Hey, curious about the neighborhood vibe over there"));
    expect(result).toEqual({ handled: false });
  });

  it("a later unmatched message falls through to default handling", async () => {
    seedListing();
    const result = await routeInboundSms(
      ctx("Is the neighborhood quiet at night usually?", { isFirstMessageInConversation: false }),
    );
    expect(result).toEqual({ handled: false });
  });

  it("a rent question answers with the listing's price line", async () => {
    seedListing();
    const result = await routeInboundSms(ctx("how much is rent?", { isFirstMessageInConversation: false }));
    expect(result.handled).toBe(true);
    expect(result.autoReplyBody).toContain("$1,050/mo");
    expect(result.autoReplyBody).toContain("/rent/listings/mgr-maple-house-1");
  });
});
