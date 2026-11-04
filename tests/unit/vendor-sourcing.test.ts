import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchWeb: vi.fn(),
  enqueueSms: vi.fn(),
  notify: vi.fn(),
  resolveSender: vi.fn(),
}));

vi.mock("@/lib/vendor-outreach-identity.server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/vendor-outreach-identity.server")>(), resolveVendorOutreachIdentity: mocks.resolveSender }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/work-order-auto-match", () => ({ suggestVendorsForWorkOrder: () => [] }));
vi.mock("@/lib/vendor-dispatch-settings", () => ({
  loadVendorDispatchSettings: async () => ({ quoteSourcingEnabled: true }),
}));
vi.mock("@/lib/vendor-sourcing-search.server", () => ({ searchVendorSourcingWeb: mocks.searchWeb }));
vi.mock("@/lib/phone-e164", () => ({
  normalizeE164(value: unknown) {
    if (typeof value !== "string") return null;
    const digits = value.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  },
}));
vi.mock("@/lib/work-order-taxonomy", () => ({ vendorCapabilitiesMatchCategory: () => true }));
vi.mock("@/lib/sms-consent", () => ({
  normalizeConsentPhone: (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
  readScopedSmsConsentState: vi.fn(),
  readSmsSuppressionState: vi.fn(),
}));
vi.mock("@/lib/sms-conversation-identity", () => ({ buildConversationKey: () => "conversation-key" }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: mocks.enqueueSms }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: mocks.notify }));
vi.mock("@/lib/work-order-dispatch", () => ({ isEmergencyWorkOrder: () => false }));
vi.mock("@/lib/service-automation-settings.server", () => ({
  resolveServiceAutomationSettingsForRow: async () => ({ offerExpiryHours: 48 }),
}));
vi.mock("@/lib/settings/scope-resolver.server", () => ({ createSettingsScopeCache: () => ({}) }));
vi.mock("@/lib/vendor-coordination-view", () => ({ coordinationQuote: () => null }));

import { readScopedSmsConsentState, readSmsSuppressionState } from "@/lib/sms-consent";
import { sourcingDedupeKey, sourcingStopReason, sweepVendorSourcing, vendorQuoteSmsIsCurrent, sourcingConversationCanReply } from "@/lib/vendor-sourcing.server";

type Row = Record<string, unknown>;
type Filter = { kind: string; column: string; value: unknown; extra?: unknown };

function makeDatabase({ missingEnrolledDirectory = false }: { missingEnrolledDirectory?: boolean } = {}) {
  const managerId = "manager-1";
  const workOrderId = "work-order-1";
  const job: Row = {
    id: "job-1",
    work_order_id: workOrderId,
    manager_user_id: managerId,
    state: "queued",
    stage: 0,
    lease_token: null,
    lease_until: null,
    attempts: 0,
    notified_state: null,
  };
  const work: Row = {
    id: workOrderId,
    manager_user_id: managerId,
    property_id: "property-1",
    row_data: {
      id: workOrderId,
      title: "Dripping sink",
      reference: "SRV-1",
      category: "plumbing",
      bucket: "open",
      description: "Private maintenance narrative",
    },
  };
  const tables: Record<string, Row[]> = {
    portal_work_order_records: [work],
    vendor_coordination_proposals: [],
    manager_property_records: [{ id: "property-1", manager_user_id: managerId, row_data: { city: "Seattle", zip: "98101" } }],
    manager_vendor_records: [],
    vendor_sourcing_candidates: [],
    vendor_sourcing_jobs: [job],
    work_order_vendor_offers: [],
    profiles: [],
    vendor_coordination_phone_bindings: [],
    agent_sessions: [],
  };
  const discoveryOrder: string[] = [];
  const operations: string[] = [];
  let nextCandidateId = 0;
  let claimNumber = 0;

  function matches(row: Row, filters: Filter[]) {
    return filters.every((filter) => {
      if (filter.kind === "eq") return filter.column.split("->>").reduce<unknown>((value, key) => (value as Row | null)?.[key], row) === filter.value;
      if (filter.kind === "is") return (row[filter.column] ?? null) === filter.value;
      if (filter.kind === "neq") return row[filter.column] !== filter.value;
      if (filter.kind === "in") return (filter.value as unknown[]).includes(row[filter.column]);
      if (filter.kind === "not" && filter.extra === "in") return !(String(filter.value).slice(1, -1).split(",").includes(String(row[filter.column])));
      return true;
    });
  }

  const db = {
    from(table: string) {
      let operation = "select";
      let singleton = false;
      let payload: unknown;
      const filters: Filter[] = [];
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit"]) {
        builder[method] = () => builder;
      }
      builder.maybeSingle = builder.single = () => { singleton = true; return builder; };
      builder.update = (value: unknown) => { operation = "update"; payload = value; return builder; };
      builder.upsert = (value: unknown) => { operation = "upsert"; payload = value; return builder; };
      builder.eq = (column: string, value: unknown) => { filters.push({ kind: "eq", column, value }); return builder; };
      builder.is = (column: string, value: unknown) => { filters.push({ kind: "is", column, value }); return builder; };
      builder.neq = (column: string, value: unknown) => { filters.push({ kind: "neq", column, value }); return builder; };
      builder.in = (column: string, value: unknown[]) => { filters.push({ kind: "in", column, value }); return builder; };
      builder.not = (column: string, operator: string, value: unknown) => { filters.push({ kind: "not", column, value, extra: operator }); return builder; };
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        try {
          operations.push(`${operation}:${table}:${filters.map((filter) => `${filter.column}=${String(filter.value)}`).join(",")}`);
          let data: unknown = null;
          const rows = tables[table] ?? (tables[table] = []);
          if (operation === "select") {
            const selected = rows.filter((row) => matches(row, filters));
            data = singleton ? selected[0] ?? null : selected;
            if (table === "manager_vendor_records") {
              const isShared = filters.some((filter) => filter.column === "row_data->>sharedWithManagers");
              discoveryOrder.push(isShared ? "shared" : "roster");
            }
          } else if (operation === "update") {
            for (const row of rows.filter((item) => matches(item, filters))) Object.assign(row, payload);
            data = [];
          } else if (operation === "upsert") {
            const incoming = Array.isArray(payload) ? payload as Row[] : [payload as Row];
            for (const item of incoming) {
              if (table === "vendor_sourcing_candidates") {
                const existing = rows.find((row) => row.job_id === item.job_id && row.dedupe_key === item.dedupe_key);
                if (existing) continue;
                rows.push({ id: `candidate-${++nextCandidateId}`, status: "discovered", reason: null, local_directory_id: null, proposal_id: null, outbox_id: null, ...item });
              } else {
                rows.push(item);
              }
            }
            data = incoming;
          }
          return Promise.resolve(resolve({ data, error: null }));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      };
      return builder;
    },
    async rpc(name: string, args: Row = {}) {
      if (name === "vendor_sourcing_has_viable_quote") return { data: job.hasViableQuote === true, error: null };
      if (name === "claim_vendor_sourcing") {
        if (!["queued", "sourcing", "waiting"].includes(String(job.state))) return { data: [], error: null };
        job.lease_token = `lease-${++claimNumber}`;
        job.lease_until = new Date(Date.now() + 120_000).toISOString();
        job.attempts = Number(job.attempts) + 1;
        return { data: [{ ...job }], error: null };
      }
      if (name === "transition_vendor_sourcing") {
        if (job.lease_token !== args.p_lease_token) return { data: false, error: null };
        Object.assign(job, args.p_patch, { lease_token: null, lease_until: null });
        return { data: true, error: null };
      }
      if (name === "update_vendor_sourcing_candidate") {
        if (job.lease_token !== args.p_lease_token) return { data: false, error: null };
        const candidate = tables.vendor_sourcing_candidates.find((row) => row.id === args.p_candidate_id);
        if (candidate) Object.assign(candidate, args.p_patch);
        return { data: true, error: null };
      }
      if (name === "enroll_vendor_sourcing_candidate") {
        if (job.lease_token !== args.p_lease_token) return { data: null, error: { message: "Sourcing lease lost" } };
        const candidate = tables.vendor_sourcing_candidates.find((row) => row.id === args.p_candidate_id);
        const contact = (tables.vendor_sourcing_candidates[0]?.contact ?? {}) as Row;
        const directoryId = "local-sourced-1";
        if (!missingEnrolledDirectory) tables.manager_vendor_records.push({ id: directoryId, manager_user_id: managerId, vendor_user_id: null, row_data: { ...contact, active: true, phone: contact.phone ?? null } });
        if (candidate) Object.assign(candidate, { local_directory_id: directoryId, proposal_id: "proposal-1" });
        return { data: { local_directory_id: directoryId, proposal_id: "proposal-1" }, error: null };
      }
      return { data: null, error: { message: `Unexpected RPC ${name}` } };
    },
    state: { tables, discoveryOrder, operations, job, workOrderId, managerId },
  };
  return db;
}

beforeEach(() => {
  mocks.searchWeb.mockReset();
  mocks.resolveSender.mockReset().mockResolvedValue({ mode: "software", managerUserId: "manager-1", displayName: "QA Customer", legalName: "QA Customer", email: "qa@verified.example", workPhone: "+12065550199", messagingServiceSid: "MGqa", version: 1 });
  vi.mocked(readScopedSmsConsentState).mockResolvedValue({ ok: true, state: "granted" } as never);
  vi.mocked(readSmsSuppressionState).mockResolvedValue({ ok: true, optedOut: false } as never);
  mocks.enqueueSms.mockReset();
  mocks.notify.mockReset().mockResolvedValue(undefined);
});

describe("vendor sourcing decisions", () => {
  it("deduplicates the same vendor across sources by normalized phone", () => {
    expect(sourcingDedupeKey({ name: "Vendor One", trade: "plumbing", phone: "(206) 555-0100", email: "a@example.test", sourceUrl: "https://one.test" }))
      .toBe(sourcingDedupeKey({ name: "Different Listing", trade: "plumbing", phone: "+1 206-555-0100", email: "b@example.test", sourceUrl: "https://two.test" }));
  });

  it("stops when a service is assigned or a manager-approved visit exists", () => {
    expect(sourcingStopReason({ bucket: "open", vendorId: "vendor-1" }, [])).toMatch(/assigned/i);
    expect(sourcingStopReason({ bucket: "open" }, [{ status: "approved" }])).toMatch(/approved/i);
    expect(sourcingStopReason({ bucket: "open" }, [])).toBeNull();
  });

  it("stops discovery after an exact email quote without availability", async () => {
    const db = makeDatabase();
    db.state.job.hasViableQuote = true; // Authoritative viability RPC, proved independently in PostgreSQL.
    db.state.tables.vendor_coordination_proposals.push({ work_order_id: db.state.workOrderId, vendor_directory_id: "vendor", status: "collecting", labor_cents: 19000, materials_cents: 0, consultation_fee_cents: 0, scope: "Repair pipe", duration_minutes: 60, vendor_windows: [] });
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    expect(db.state.job.state).toBe("quote_collected");
    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(mocks.enqueueSms).not.toHaveBeenCalled();
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    expect(db.state.job.state).toBe("quote_collected");
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it("tries roster, shared vendors, then web, and leaves unverified web results at a permission blocker", async () => {
    const db = makeDatabase();
    mocks.searchWeb.mockResolvedValue({
      status: "available",
      candidates: [{ name: "Web Plumber", url: "https://plumber.example", description: "Licensed plumbing", resultRank: 1, fetchedAt: new Date().toISOString(), phoneEvidence: null, normalizedPhone: null }],
    });

    await sweepVendorSourcing(db as never, db.state.workOrderId);
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    await sweepVendorSourcing(db as never, db.state.workOrderId);

    expect(db.state.discoveryOrder).toEqual(["roster", "shared"]);
    expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
    expect(mocks.searchWeb).toHaveBeenCalledWith({ category: "plumbing", city: "Seattle", zip: "98101" });
    expect(db.state.tables.vendor_sourcing_candidates).toMatchObject([
      { source: "web", status: "manual_contact_required", reason: expect.stringMatching(/appropriate channel/i) },
    ]);
    expect(mocks.enqueueSms).not.toHaveBeenCalled();
    expect(db.state.job).toMatchObject({ state: "needs_attention", stage: 2 });
  });

  it("stops contact when the enrolled vendor directory row is missing", async () => {
    const db = makeDatabase({ missingEnrolledDirectory: true });
    mocks.searchWeb.mockResolvedValue({ status: "available", candidates: [{ name: "Web Plumber", url: "https://plumber.example", description: "Plumbing", resultRank: 1, fetchedAt: new Date().toISOString(), phoneEvidence: "business site", normalizedPhone: "+12065550100" }] });
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    await sweepVendorSourcing(db as never, db.state.workOrderId);
    expect(db.state.tables.vendor_sourcing_candidates).toMatchObject([{ status: "permission_required", reason: expect.stringMatching(/directory unavailable/i) }]);
    expect(readScopedSmsConsentState).not.toHaveBeenCalled();
    expect(mocks.enqueueSms).not.toHaveBeenCalled();
  });
});

function currentContactFixture(linked = false) {
  const db = makeDatabase(); const { tables, job, managerId } = db.state;
  const phone = "+12065550100"; const expiry = new Date(Date.now() + 3600000).toISOString();
  job.stage = 2;
  tables.vendor_sourcing_candidates.push({ id: "earlier", job_id: job.id, manager_user_id: managerId, stage: 0, source: "roster", contact: { name: "Plumber", phone }, dedupe_key: `phone:${phone}`, local_directory_id: "local-sourced-1", source_directory_id: "local-sourced-1", status: "permission_required", expires_at: expiry });
  tables.vendor_sourcing_candidates.push({ id: "web-exhausted", job_id: job.id, stage: 2, source: "web", contact: {}, dedupe_key: "exhausted", status: "expired", expires_at: new Date(0).toISOString() });
  tables.manager_vendor_records.push({ id: "local-sourced-1", manager_user_id: managerId, vendor_user_id: linked ? "vendor-user" : null, row_data: { phone, active: true } });
  tables.vendor_coordination_phone_bindings.push({ manager_user_id: managerId, vendor_directory_id: "local-sourced-1", phone_e164: phone, verified_at: "2026-01-01", revoked_at: null });
  tables.work_order_vendor_offers.push({ work_order_id: job.work_order_id, vendor_directory_id: "local-sourced-1", manager_user_id: managerId, status: "sent", expires_at: expiry });
  return { db, input: { managerUserId: managerId, recipientPhone: phone, recipientUserId: linked ? "vendor-user" : null, conversationKey: "conversation-key", counterpartyRole: "vendor", dedupeKey: `vendor-quote:${job.work_order_id}:phone:${phone}` } };
}

describe("current verified sourcing identity", () => {
  it("keeps exact existing SMS consent usable without a work mailbox", async () => {
    const { db, input } = currentContactFixture();
    mocks.resolveSender.mockResolvedValue({ mode: "software", managerUserId: "manager-1", displayName: "QA Customer", legalName: "QA Customer", email: "", workPhone: "+12065550199", messagingServiceSid: "MGqa", version: 1 });
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    expect(mocks.resolveSender).toHaveBeenCalledWith(db, "manager-1", "work-order-1", "sms");
  });

  it.each(["displayName", "legalName", "email", "workspaceId", "workPhone", "messagingServiceSid", "mode", "version", "managerUserId"])("rejects a page SMS grant after sender %s changes at dispatch", async (field) => {
    const { db, input } = currentContactFixture();
    const sender = { mode: "software", managerUserId: "manager-1", workspaceId: "workspace-1", displayName: "QA Customer", legalName: "QA Customer", email: "qa@example.test", workPhone: "+12065550199", messagingServiceSid: "MGqa", version: 1 };
    mocks.resolveSender.mockResolvedValue(sender);
    db.state.tables.sms_consent_events = [{ recipient_phone_key: "2065550100", manager_user_id: "manager-1", purpose: "vendor_quote_request", send_class: "automated", conversation_key: "conversation-key", messaging_service_sid: "MGqa", event_type: "granted", source: "verified_vendor_quote_inbound_challenge", evidence: { candidateId: "earlier" } }];
    db.state.tables.vendor_quote_sms_consent_events = [{ candidate_id: "earlier", phone_e164: input.recipientPhone, capability_id: "cap", work_phone: sender.workPhone, messaging_service_sid: sender.messagingServiceSid, revoked_at: null }];
    db.state.tables.vendor_quote_contact_capabilities = [{ id: "cap", manager_user_id: "manager-1", work_order_id: "work-order-1", candidate_id: "earlier", sender_mode: "software", sender_version: 1, sender_snapshot: { ...sender }, expires_at: "2099-01-01", revoked_at: null }];
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    mocks.resolveSender.mockResolvedValue({ ...sender, [field]: field === "version" ? 2 : "changed" });
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
  });

  it("keeps collected SMS replies scoped to the live offer and unapproved proposal", async () => {
    const { db, input } = currentContactFixture();
    db.state.job.state = "quote_collected";
    db.state.tables.vendor_sourcing_candidates[0].proposal_id = "proposal";
    const proposal = { id: "proposal", work_order_id: "work-order-1", manager_user_id: "manager-1", status: "collecting" };
    db.state.tables.vendor_coordination_proposals.push(proposal);
    const scope = { phone: input.recipientPhone, directoryId: "local-sourced-1", conversationKey: "conversation-key" };
    expect(await sourcingConversationCanReply(db as never, "manager-1", "work-order-1", scope)).toBe(true);
    proposal.status = "approved";
    expect(await sourcingConversationCanReply(db as never, "manager-1", "work-order-1", scope)).toBe(false);
    proposal.status = "collecting";
    db.state.tables.work_order_vendor_offers[0].expires_at = null;
    expect(await sourcingConversationCanReply(db as never, "manager-1", "work-order-1", scope)).toBe(false);
  });

  it("never reuses service-specific page consent for a different candidate", async () => {
    const { db, input } = currentContactFixture();
    db.state.tables.sms_consent_events = [{ recipient_phone_key: "2065550100", manager_user_id: "manager-1", purpose: "vendor_quote_request", send_class: "automated", conversation_key: "conversation-key", messaging_service_sid: "MGqa", event_type: "granted", source: "verified_vendor_quote_inbound_challenge", evidence: { candidateId: "another-service-candidate" } }];
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
  });

  it.each(["declined", "cancelled", "expired", "opted_out", "withdrawn"])("fences a claimed opening whose candidate became %s after enqueue", async (status) => {
    const { db, input } = currentContactFixture();
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    db.state.tables.vendor_sourcing_candidates[0].status = status;
    // A reopened job and even a stale sent offer must not revive the opening.
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
  });

  it("fences terminal-only proposals even if candidate and offer reconciliation is stale",async () => {
    const { db, input } = currentContactFixture();
    db.state.tables.vendor_coordination_proposals.push({vendor_directory_id:"local-sourced-1",work_order_id:db.state.job.work_order_id,status:"declined"});
    expect(await vendorQuoteSmsIsCurrent(db as never,input)).toBe(false);
    db.state.tables.vendor_coordination_proposals.push({vendor_directory_id:"local-sourced-1",work_order_id:db.state.job.work_order_id,status:"collecting",visit_type:"consultation"});
    expect(await vendorQuoteSmsIsCurrent(db as never,input)).toBe(true);
  });
  it("accepts a current directory binding, then rejects its revocation without changing phone/consent", async () => {
    const { db, input } = currentContactFixture();
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    db.state.tables.vendor_coordination_phone_bindings[0].revoked_at = "2026-10-16";
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
  });
  it("requires the current linked verified phone and stored recipient identity", async () => {
    const { db, input } = currentContactFixture(true);
    db.state.tables.vendor_coordination_phone_bindings.length = 0;
    const profile = { id: "vendor-user", phone: input.recipientPhone, phone_verified_at: "2026-01-01" };
    db.state.tables.profiles.push(profile);
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    profile.phone_verified_at = "";
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
    profile.phone_verified_at = "2026-01-01"; profile.phone = "+12065550101";
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
    profile.phone = input.recipientPhone;
    db.state.tables.manager_vendor_records[0].vendor_user_id = "replacement-user";
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(false);
  });
  it.each([["Leaking pipe", "A pipe is leaking."], ["Clogged drain", "A drain is clogged."], ["The pipe is not leaking", "Problem not specified"]])("uses safe shared facts in sourced SMS for %s", async (description, expected) => {
    const { db } = currentContactFixture();
    db.state.tables.portal_work_order_records[0].row_data = { bucket: "open", category: "plumbing", title: "Plumbing issue", description, reference: "WO-2048", privateNotes: "door code 4321", residentEmail: "private@example.test", propertyAddress: "123 Secret Street" };
    mocks.enqueueSms.mockResolvedValue({ ok: true, status: "queued", outboxId: "outbox-1" });
    await sweepVendorSourcing(db as never);
    expect(mocks.enqueueSms).toHaveBeenCalledOnce();
    const body = mocks.enqueueSms.mock.calls[0][0].body;
    expect(body).toContain(`Service SR-2048 in Seattle: ${expected}`);
    for (const value of ["door code 4321", "private@example.test", "123 Secret Street"]) expect(body).not.toContain(value);
  });

  it("keeps an earlier-stage permitted candidate waiting and reconciles its later expiry", async () => {
    const { db, input } = currentContactFixture();
    mocks.enqueueSms.mockResolvedValue({ ok: true, status: "queued", outboxId: "outbox-1" });
    await sweepVendorSourcing(db as never);
    expect(mocks.enqueueSms).toHaveBeenCalledTimes(1);
    expect(db.state.job.state).toBe("waiting");
    expect(await vendorQuoteSmsIsCurrent(db as never, input)).toBe(true);
    db.state.tables.sms_outbox = [{ id: "outbox-1", manager_user_id: db.state.managerId, status: "delivered" }];
    await sweepVendorSourcing(db as never);
    expect(db.state.job.state).toBe("waiting");
    db.state.tables.vendor_sourcing_candidates[0].expires_at = new Date(0).toISOString();
    await sweepVendorSourcing(db as never);
    expect(db.state.tables.vendor_sourcing_candidates[0].status).toBe("expired");
    expect(db.state.job.state).toBe("needs_attention");
    expect(mocks.enqueueSms).toHaveBeenCalledTimes(1);
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });
});
