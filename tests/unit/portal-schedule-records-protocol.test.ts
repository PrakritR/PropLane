import { beforeEach, describe, expect, it, vi } from "vitest";
import { isActivePlannedEvent, type PlannedEvent } from "@/lib/demo-admin-scheduling";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  portal: {
    user: { id: "owner-a", email: "owner-a@example.test" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { email: "owner-a@example.test", role: "manager" },
  } as Record<string, unknown>,
  admin: false,
  scheduleRows: [] as Row[],
  properties: [] as Row[],
  links: [] as Row[],
  replace: vi.fn(async () => ({ available: true, ok: true, idempotent: false })),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => void task() };
});
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => state.portal }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => state.admin }));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({
  replaceManagerPlannedScheduleSlice: (...args: unknown[]) => state.replace(...args),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncManagerAvailabilityToGoogleCalendar: vi.fn() }));
vi.mock("@/lib/tour-events.server", () => ({ emitAvailabilityChangedEvent: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => query(table),
  }),
}));

type Query = Record<string, unknown> & PromiseLike<{ data: Row[]; error: null }>;

function query(table: string): Query {
  const filters: Record<string, unknown> = {};
  let deleting = false;
  const chain: Record<string, unknown> = {};
  const rowsFor = (): Row[] => {
    if (table === "portal_schedule_records") {
      const id = typeof filters.id === "string" ? filters.id : null;
      const ids = Array.isArray(filters["in:id"]) ? filters["in:id"] as unknown[] : null;
      const propertyIds = Array.isArray(filters["in:property_id"])
        ? filters["in:property_id"] as unknown[]
        : null;
      const legacyPropertyIds = Array.isArray(filters["in:row_data->>propertyId"])
        ? filters["in:row_data->>propertyId"] as unknown[]
        : null;
      const source = id
        ? state.scheduleRows.filter((row) => row.id === id)
        : ids
          ? state.scheduleRows.filter((row) => ids.includes(row.id))
          : propertyIds
            ? state.scheduleRows.filter((row) => propertyIds.includes(row.property_id))
            : legacyPropertyIds
              ? state.scheduleRows.filter((row) => legacyPropertyIds.includes((row.row_data as Row | undefined)?.propertyId))
          : state.scheduleRows;
      const excluded = Array.isArray(filters.neq) ? filters.neq : [];
      const ordinary = excluded.length > 0
        ? source.filter((row) => !excluded.includes(row.id))
        : source;
      // Scope checks are the only queries carrying an .or() filter. The real
      // route's scope allows own ordinary rows and its shared singleton rows.
      if (filters.scope === true && !state.admin) {
        const viewer = (state.portal.user as { id: string }).id;
        const scoped = ordinary.filter((row) => {
          if (row.id === "axis_admin_planned_events_v1" || row.id === "axis_admin_partner_inquiries_v1") return true;
          return row.manager_user_id === viewer;
        });
        return typeof filters.limit === "number" ? scoped.slice(0, filters.limit) : scoped;
      }
      return typeof filters.limit === "number" ? ordinary.slice(0, filters.limit) : ordinary;
    }
    if (table === "manager_property_records") {
      const ids = Array.isArray(filters["in:id"]) ? filters["in:id"] as unknown[] : [];
      return state.properties.filter((row) => ids.length === 0 || ids.includes(row.id));
    }
    if (table === "account_link_invites") {
      const viewer = filters.invitee_user_id;
      return state.links.filter((row) => row.status === "accepted" && (!viewer || row.invitee_user_id === viewer));
    }
    return [];
  };
  const result = async () => {
    const rows = rowsFor();
    if (deleting && table === "portal_schedule_records") {
      const ids = new Set(rows.map((row) => String(row.id)));
      state.scheduleRows = state.scheduleRows.filter((row) => !ids.has(String(row.id)));
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    }
    return { data: rows, error: null };
  };
  Object.assign(chain, {
    select: () => chain,
    order: () => chain,
    limit: (value: number) => {
      filters.limit = value;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    in: (column: string, values: unknown[]) => {
      filters[`in:${column}`] = values;
      return chain;
    },
    neq: (_column: string, value: unknown) => {
      const excluded = Array.isArray(filters.neq) ? filters.neq : [];
      filters.neq = [...excluded, value];
      return chain;
    },
    or: () => {
      filters.scope = true;
      return chain;
    },
    delete: () => {
      deleting = true;
      return chain;
    },
    maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) => result().then(resolve, reject),
  });
  return chain as Query;
}

function portal(id: string, roles: string[] = ["manager"]) {
  state.admin = roles.includes("admin");
  state.portal = {
    user: { id, email: `${id}@example.test` },
    roles,
    effectiveRole: roles.length === 1 ? roles[0] : null,
    profile: { email: `${id}@example.test`, role: roles[0] },
  };
}

function singleton(id: string, payload: Row[]): Row {
  return { id, record_type: id, row_data: { id, recordType: id, payload } };
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const plannedId = "axis_admin_planned_events_v1";
const inquiriesId = "axis_admin_partner_inquiries_v1";

beforeEach(() => {
  portal("owner-a");
  state.scheduleRows = [];
  state.properties = [
    { id: "property-a", manager_user_id: "owner-a" },
    { id: "property-b", manager_user_id: "owner-b" },
  ];
  state.links = [];
  state.replace.mockClear().mockResolvedValue({ available: true, ok: true, idempotent: false });
});

describe("portal schedule-records protocol", () => {
  it("prevalidates every deleteIds target in either order and never partially deletes", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    for (const protectedId of [plannedId, inquiriesId]) {
      for (const ids of [["ordinary-owner-a", protectedId], [protectedId, "ordinary-owner-a"]]) {
        state.scheduleRows = [
          singleton(plannedId, []),
          singleton(inquiriesId, []),
          { id: "ordinary-owner-a", manager_user_id: "owner-a", record_type: "event", row_data: { id: "ordinary-owner-a" } },
        ];
        const response = await POST(post({ action: "deleteIds", ids }));
        expect(response.status).toBe(403);
        expect(state.scheduleRows.map((row) => row.id)).toEqual([plannedId, inquiriesId, "ordinary-owner-a"]);
      }
    }
  });

  it("fails closed for every role at either shared singleton while preserving ordinary owned deletion", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    for (const [id, roles] of [
      ["resident-1", ["resident"]],
      ["manager-other", ["manager"]],
      ["owner-a", ["manager"]],
      ["vendor-1", ["vendor"]],
      ["admin-1", ["admin"]],
    ] as const) {
      portal(id, [...roles]);
      state.scheduleRows = [singleton(plannedId, []), singleton(inquiriesId, [])];
      for (const protectedId of [plannedId, inquiriesId]) {
        const response = await POST(post({ action: "delete", id: protectedId }));
        expect(response.status).toBeGreaterThanOrEqual(403);
        expect(state.scheduleRows).toHaveLength(2);
      }
    }
    portal("owner-a");
    state.scheduleRows = [{ id: "ordinary-owner-a", manager_user_id: "owner-a", record_type: "event", row_data: { id: "ordinary-owner-a" } }];
    const allowed = await POST(post({ action: "delete", id: "ordinary-owner-a" }));
    expect(allowed.status).toBe(200);
    expect(state.scheduleRows).toEqual([]);
  });

  it("rejects inquiry singleton upsert and mixed replace before any row is mutated", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const ordinary = { id: "ordinary-owner-a", manager_user_id: "owner-a", record_type: "event", row_data: { id: "ordinary-owner-a" } };
    for (const [id, roles] of [
      ["resident-1", ["resident"]],
      ["manager-other", ["manager"]],
      ["owner-a", ["manager"]],
      ["vendor-1", ["vendor"]],
      ["admin-1", ["admin"]],
    ] as const) {
      portal(id, [...roles]);
      for (const payload of [[], [{ id: "forged-inquiry", managerUserId: "owner-a" }]]) {
        const inquiry = { id: inquiriesId, recordType: inquiriesId, payload };
        state.scheduleRows = [ordinary, singleton(inquiriesId, [{ id: "stored-inquiry" }])];
        const upsert = await POST(post({ action: "upsert", row: inquiry }));
        expect(upsert.status).toBe(403);
        expect(state.scheduleRows).toEqual([ordinary, singleton(inquiriesId, [{ id: "stored-inquiry" }])]);
        for (const rows of [[ordinary, inquiry], [inquiry, ordinary]]) {
          const response = await POST(post({ action: "replace", rows }));
          expect(response.status).toBe(403);
          expect(state.scheduleRows).toEqual([ordinary, singleton(inquiriesId, [{ id: "stored-inquiry" }])]);
        }
      }
    }
  });

  it("does not let more than 500 unrelated ordinary rows starve an owned row or singleton baseline", async () => {
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const unrelated = Array.from({ length: 501 }, (_, index) => ({
      id: `ordinary-other-${index}`,
      manager_user_id: "owner-other",
      record_type: "event",
      row_data: { id: `ordinary-other-${index}` },
    }));
    state.scheduleRows = [
      ...unrelated,
      { id: "ordinary-owner-a", manager_user_id: "owner-a", record_type: "event", row_data: { id: "ordinary-owner-a" } },
      singleton(plannedId, []),
    ];
    const body = await (await GET()).json() as { rows: Row[] };
    expect(body.rows.some((row) => row.id === "ordinary-owner-a")).toBe(true);
    expect(body.rows.some((row) => row.id === plannedId)).toBe(true);
  });

  it("pages linked ordinary rows by authorized property before the limit", async () => {
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    portal("co-a");
    state.links = [{
      status: "accepted",
      invitee_user_id: "co-a",
      inviter_user_id: "owner-a",
      assigned_property_ids: ["property-a"],
      property_co_manager_permissions: { "property-a": { applications: { edit: true } } },
    }];
    state.scheduleRows = [
      ...Array.from({ length: 501 }, (_, index) => ({
        id: `unrelated-owner-row-${index}`,
        manager_user_id: "owner-a",
        property_id: "property-b",
        record_type: "tour_inquiry",
        row_data: { id: `unrelated-${index}`, kind: "tour", status: "pending", managerUserId: "owner-a", propertyId: "property-b" },
      })),
      {
        id: "authorized-older-inquiry",
        manager_user_id: "owner-a",
        property_id: "property-a",
        record_type: "tour_inquiry",
        row_data: { id: "authorized-older-inquiry", kind: "tour", status: "pending", managerUserId: "owner-a", propertyId: "property-a", eligibleHostUserIds: ["co-a"] },
      },
      singleton(plannedId, []),
    ];
    const body = await (await GET()).json() as { rows: Row[] };
    expect(body.rows.filter((row) => row.id === "authorized-older-inquiry")).toHaveLength(1);
    expect(body.rows.some((row) => String(row.id).startsWith("unrelated-owner-row-"))).toBe(false);
  });

  it("projects shared and standalone tours by authenticated property authority without leaking prospect contacts", async () => {
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const ownerATour = {
      id: "tour-a", kind: "tour", managerUserId: "owner-a", propertyId: "property-a", start: "2030-01-01T18:00:00.000Z", end: "2030-01-01T18:30:00.000Z",
      guestName: "Ava Prospect", guestPhone: "+15550000001", guestEmail: "ava@example.test", canceledAt: "2030-01-01T17:00:00.000Z",
    };
    const ownerBTour = {
      id: "tour-b", kind: "tour", managerUserId: "owner-b", propertyId: "property-b", start: "2030-01-01T19:00:00.000Z", end: "2030-01-01T19:30:00.000Z",
      guestName: "Bea Prospect", guestPhone: "+15550000002", guestEmail: "bea@example.test",
    };
    const missingOwner = { id: "tour-missing", kind: "tour", propertyId: "missing-property", guestName: "Hidden" };
    const inquiryA = { id: "inquiry-a", kind: "tour", status: "pending", managerUserId: "owner-a", propertyId: "property-a", proposedStart: "2030-01-02T18:00:00.000Z", guestName: "Ava Prospect", phone: "+15550000001", email: "ava@example.test" };
    const inquiryB = { id: "inquiry-b", kind: "tour", status: "pending", managerUserId: "owner-b", propertyId: "property-b", guestName: "Bea Prospect", phone: "+15550000002", email: "bea@example.test" };
    state.scheduleRows = [
      singleton(plannedId, [ownerATour, ownerBTour, missingOwner, { id: "task-a", kind: "task", managerUserId: "owner-a", title: "Owner task" }]),
      singleton(inquiriesId, [inquiryA, inquiryB]),
      { id: "standalone-a", record_type: "tour_inquiry", manager_user_id: "owner-a", row_data: inquiryA },
      { id: "standalone-missing", record_type: "tour_inquiry", row_data: { ...inquiryA, id: "standalone-missing", managerUserId: null, propertyId: "missing-property", guestName: "Hidden" } },
    ];

    portal("owner-a", ["resident", "manager"]);
    let body = await (await GET()).json() as { rows: Row[] };
    const ownerPlanned = body.rows.find((row) => row.id === plannedId)!;
    expect((ownerPlanned.payload as Row[]).map((row) => row.id)).toEqual(["tour-a", "task-a"]);
    expect(JSON.stringify(body)).toContain("ava@example.test");
    expect(JSON.stringify(body)).not.toContain("bea@example.test");

    portal("owner-b");
    body = await (await GET()).json() as { rows: Row[] };
    const ownerBPlanned = body.rows.find((row) => row.id === plannedId)!;
    expect((ownerBPlanned.payload as Row[]).map((row) => row.id)).toEqual(["tour-b"]);
    expect(JSON.stringify(body)).toContain("bea@example.test");
    expect(JSON.stringify(body)).not.toContain("ava@example.test");

    portal("manager-other");
    body = await (await GET()).json() as { rows: Row[] };
    expect(body.rows).toEqual([{ id: plannedId, recordType: plannedId, payload: [] }]);

    portal("resident-1", ["resident"]);
    expect((await (await GET()).json() as { rows: Row[] }).rows).toEqual([]);

    portal("vendor-1", ["vendor"]);
    expect((await (await GET()).json() as { rows: Row[] }).rows).toEqual([]);

    portal("admin-1", ["admin"]);
    body = await (await GET()).json() as { rows: Row[] };
    expect(JSON.stringify(body)).toContain("ava@example.test");
    expect(JSON.stringify(body)).toContain("bea@example.test");
    expect(JSON.stringify(body)).toContain("Hidden");

    portal("co-a");
    state.links = [{
      status: "accepted", invitee_user_id: "co-a", inviter_user_id: "owner-a", assigned_property_ids: ["property-a"],
      property_co_manager_permissions: { "property-a": { calendar: { read: true } } },
    }];
    body = await (await GET()).json() as { rows: Row[] };
    const coPlanned = body.rows.find((row) => row.id === plannedId)!;
    expect((coPlanned.payload as Row[]).map((row) => row.id)).toEqual(["tour-a"]);
    expect((coPlanned.payload as Row[])[0]).toMatchObject({ canceledAt: "2030-01-01T17:00:00.000Z" });
    expect(isActivePlannedEvent((coPlanned.payload as Row[])[0] as PlannedEvent)).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Ava Prospect");
    expect(JSON.stringify(body)).not.toContain("ava@example.test");
    expect(body.rows.some((row) => row.id === "inquiry-a" && row.kind === "tour")).toBe(true);

    state.links[0] = { ...state.links[0]!, assigned_property_ids: ["property-b"], property_co_manager_permissions: { "property-b": { calendar: { read: true } } } };
    body = await (await GET()).json() as { rows: Row[] };
    expect(body.rows).toEqual([{ id: plannedId, recordType: plannedId, payload: [] }]);

    state.links[0] = { ...state.links[0]!, assigned_property_ids: ["property-a"], property_co_manager_permissions: { "property-a": {} } };
    body = await (await GET()).json() as { rows: Row[] };
    expect(body.rows).toEqual([{ id: plannedId, recordType: plannedId, payload: [] }]);
  });

  it("accepts a projected manager baseline without forwarding hidden tours or a concurrently appended booking into CAS", async () => {
    const { GET, POST } = await import("@/app/api/portal-schedule-records/route");
    const ownTask = { id: "task-a", kind: "task", managerUserId: "owner-a", title: "Before" };
    state.scheduleRows = [singleton(plannedId, [ownTask, { id: "tour-a", kind: "tour", managerUserId: "owner-a", propertyId: "property-a", guestEmail: "ava@example.test" }])];
    portal("owner-a");
    const baseline = await (await GET()).json() as { rows: Row[] };
    const projected = baseline.rows.find((row) => row.id === plannedId)!;
    state.scheduleRows[0] = singleton(plannedId, [
      ownTask,
      { id: "tour-a", kind: "tour", managerUserId: "owner-a", propertyId: "property-a", guestEmail: "ava@example.test" },
      { id: "tour-new", kind: "tour", managerUserId: "owner-b", propertyId: "property-b", guestEmail: "bea@example.test" },
    ]);
    const response = await POST(post({
      action: "upsert",
      row: { id: plannedId, recordType: plannedId, payload: [{ ...ownTask, title: "After" }, ...(projected.payload as Row[]).filter((row) => row.kind === "tour")] },
      expectedPayloadKnown: true,
      expectedPayload: projected.payload,
    }));
    expect(response.status).toBe(200);
    expect(state.replace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      managerUserId: "owner-a",
      events: [{ ...ownTask, title: "After" }],
      expectedEvents: [ownTask],
    }));
    expect(JSON.stringify(state.replace.mock.calls)).not.toContain("tour-new");
  });

  it("projects a pending inquiry to an applications-edit host only when the trusted roster includes them", async () => {
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    state.scheduleRows = [singleton(inquiriesId, [{
      id: "inquiry-rostered",
      kind: "tour",
      status: "pending",
      managerUserId: "owner-a",
      propertyId: "property-a",
      eligibleHostUserIds: ["co-a"],
      requestedWindows: [{ start: "2030-01-02T18:00:00.000Z", end: "2030-01-02T18:30:00.000Z", adminLabel: "Owner A" }],
      guestName: "Ava Prospect",
    }])];
    portal("co-a");
    state.links = [{
      status: "accepted",
      invitee_user_id: "co-a",
      inviter_user_id: "owner-a",
      assigned_property_ids: ["property-a"],
      property_co_manager_permissions: { "property-a": { applications: { edit: true } } },
    }];
    const body = await (await GET()).json() as { rows: Row[] };
    const inquiry = body.rows.find((row) => row.id === inquiriesId);
    expect(inquiry).toBeDefined();
    expect((inquiry!.payload as Row[]).map((row) => row.id)).toEqual(["inquiry-rostered"]);
    expect((inquiry!.payload as Row[])[0]).toMatchObject({ eligibleHostUserIds: ["co-a"] });
    expect((inquiry!.payload as Row[])[0]).toMatchObject({ requestedWindows: [{ start: "2030-01-02T18:00:00.000Z", end: "2030-01-02T18:30:00.000Z" }] });
    expect(JSON.stringify(inquiry)).not.toContain("Ava Prospect");
  });
});
