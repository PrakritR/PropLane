import { describe, expect, it } from "vitest";
import {
  blockingFormsFromRows,
  BLOCKING_FORMS_FAIL_CLOSED,
  leaseApplicationIds,
  leaseOwnApplicationIds,
  loadApplicationBlockingForms,
  loadResidentBlockingForms,
  loadResidentFormsFacts,
  NO_BLOCKING_FORMS,
} from "@/lib/move-in-forms/blocking";
import { defaultMoveInFormBlocks, resolveMoveInFormBlocks } from "@/lib/move-in-forms/types";
import { normalizeMoveInFormTemplates } from "@/lib/move-in-forms/templates";

const row = (patch: Record<string, unknown> = {}) => ({
  id: "r1", resident_user_id: "u1", form_id: "f1", status: "sent", sent_at: "2026-10-01T00:00:00Z", snapshot: { kind: "other" as const }, ...patch,
});

describe("what a form blocks defaults by kind and is read from the snapshot", () => {
  it("an intake form blocks Move-in details and every other kind blocks nothing, until a value is stored", () => {
    expect(defaultMoveInFormBlocks("intake")).toBe("move_in_details");
    for (const kind of ["move-in", "move-out", "other"] as const) expect(defaultMoveInFormBlocks(kind)).toBe("nothing");
    expect(resolveMoveInFormBlocks(undefined, "intake")).toBe("move_in_details");
    expect(resolveMoveInFormBlocks("approval", "intake")).toBe("approval");
    expect(resolveMoveInFormBlocks("not-a-block", "other")).toBe("nothing");
  });

  it("a template keeps only a known blocks value, so an absent one derives from the kind", () => {
    const [kept, junk] = normalizeMoveInFormTemplates([
      { id: "mif-a", name: "A", source: "built", questions: [], blocks: "lease_signing" },
      { id: "mif-b", name: "B", source: "built", questions: [], blocks: "bogus" },
    ]);
    expect(kept!.blocks).toBe("lease_signing");
    expect(junk!.blocks).toBeUndefined();
  });
});

describe("blockingFormsPending derivation", () => {
  it("is nothing for a resident with no unsubmitted forms", () => {
    expect(blockingFormsFromRows([])).toMatchObject({ moveInDetails: false, leaseSigning: false, approval: false });
  });

  it("derives each flag from the sent forms' snapshot.blocks", () => {
    const result = blockingFormsFromRows([
      row({ id: "a", snapshot: { kind: "other", blocks: "move_in_details" } }),
      row({ id: "b", snapshot: { kind: "other", blocks: "lease_signing" } }),
      row({ id: "c", snapshot: { kind: "other", blocks: "approval" } }),
    ]);
    expect(result).toMatchObject({ moveInDetails: true, leaseSigning: true, approval: true });
    expect(result.formIds).toEqual({ moveInDetails: "a", leaseSigning: "b", approval: "c" });
  });

  it("falls back to the kind's default: an old intake form with no stored blocks still blocks Move-in details", () => {
    expect(blockingFormsFromRows([row({ snapshot: { kind: "intake" } })]).moveInDetails).toBe(true);
    expect(blockingFormsFromRows([row({ form_id: "default-intake", snapshot: {} })]).moveInDetails).toBe(true);
    expect(blockingFormsFromRows([row({ snapshot: { kind: "move-in" } })]).moveInDetails).toBe(false);
    expect(blockingFormsFromRows([row({ snapshot: null })]).moveInDetails).toBe(false);
  });

  it("only a SENT copy blocks: a submitted or cancelled one never does, and an explicit Nothing wins over the kind", () => {
    const rows = [
      row({ id: "s", status: "submitted", snapshot: { kind: "intake", blocks: "approval" } }),
      row({ id: "c", status: "cancelled", snapshot: { kind: "intake", blocks: "lease_signing" } }),
      row({ id: "n", snapshot: { kind: "intake", blocks: "nothing" } }),
    ];
    expect(blockingFormsFromRows(rows)).toMatchObject({ moveInDetails: false, leaseSigning: false, approval: false });
  });

  it("links the oldest blocking form so the lock opens the form that unlocks it", () => {
    const result = blockingFormsFromRows([
      row({ id: "new", sent_at: "2026-10-03T00:00:00Z", snapshot: { blocks: "approval" } }),
      row({ id: "old", sent_at: "2026-10-01T00:00:00Z", snapshot: { blocks: "approval" } }),
    ]);
    expect(result.formIds?.approval).toBe("old");
  });
});

type FakeAnswer = { data?: unknown[]; error?: { code?: string; message?: string } | null } | "throw";

/**
 * A three-table fake: `result` answers `resident_move_in_forms`, `applications` answers
 * `manager_application_records` and `leases` answers `portal_lease_pipeline_records` (the two arms
 * of the bound-application scope). `calls` / `selects` record the forms read only, so the
 * single-forms-read guarantee stays assertable; `scopeCalls` records the other two.
 */
function fakeDb(result: FakeAnswer, applications: FakeAnswer = { data: [] }, leases: FakeAnswer = { data: [] }) {
  const calls: Array<[string, string, unknown]> = [];
  const selects: string[] = [];
  const scopeCalls: Array<[string, string, unknown]> = [];
  const build = (answer: FakeAnswer, log: Array<[string, string, unknown]>, selectLog: string[] | null) => {
    const query: Record<string, unknown> = {};
    const chain = (name: string) => (column: string, value: unknown) => { log.push([name, column, value]); return query; };
    query.select = (columns: string) => { selectLog?.push(columns); return query; };
    query.eq = chain("eq");
    query.neq = chain("neq");
    query.in = chain("in");
    query.or = (expression: string) => { log.push(["or", "or", expression]); return query; };
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      (answer === "throw" ? Promise.reject(new Error("down")) : Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })).then(resolve, reject);
    return query;
  };
  const forms = build(result, calls, selects);
  const apps = build(applications, scopeCalls, null);
  const leaseRows = build(leases, scopeCalls, null);
  const byTable: Record<string, unknown> = {
    manager_application_records: apps,
    portal_lease_pipeline_records: leaseRows,
  };
  return { db: { from: (table: string) => byTable[table] ?? forms } as never, calls, selects, scopeCalls };
}

describe("loading what a resident or an application is blocked on", () => {
  it("reads a resident's SENT copies by login ID and can narrow to one house", async () => {
    const { db, calls } = fakeDb({ data: [
      row({ id: "mine", resident_user_id: "u1", snapshot: { blocks: "lease_signing" } }),
      row({ id: "theirs", resident_user_id: "u2", snapshot: { blocks: "approval" } }),
    ] });
    const result = await loadResidentBlockingForms(db, { email: " A@Example.TEST ", userId: "u1", propertyId: "p1" });
    expect(result).toMatchObject({ leaseSigning: true, approval: false });
    expect(calls).toEqual(expect.arrayContaining([["eq", "status", "sent"], ["eq", "property_id", "p1"], ["eq", "resident_user_id", "u1"]]));
    // No address is ever part of the subject test: `profiles.email` is not mailbox proof.
    expect(JSON.stringify(calls)).not.toContain("resident_email");
  });

  /**
   * A block is a restriction, so an unbound row still blocks — but only inside the exact scope the
   * caller already authorized (the lease's own applications), never because an address matches.
   */
  it("an unbound blocking form blocks only for the applications this request is about, and is never named back", async () => {
    const pendingRow = row({ id: "pending", resident_user_id: null, application_id: "axis-1", snapshot: { blocks: "lease_signing" } });
    const unbound = fakeDb({ data: [pendingRow] });
    const pending = await loadResidentBlockingForms(unbound.db, { email: "a@example.test", userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] });
    expect(pending.leaseSigning).toBe(true);
    expect(pending.formIds?.leaseSigning).toBeUndefined();
    expect(unbound.calls).toContainEqual(["or", "or", 'resident_user_id.eq.u1,and(resident_user_id.is.null,or(application_id.ilike."AXIS-1",application_id.ilike."PROPLANE-1"))']);

    const own = fakeDb({ data: [row({ id: "mine", resident_user_id: "u1", application_id: "AXIS-1", snapshot: { blocks: "lease_signing" } })] });
    const mine = await loadResidentBlockingForms(own.db, { email: "a@example.test", userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] });
    expect(mine.leaseSigning).toBe(true);
    expect(mine.formIds?.leaseSigning).toBe("mine");

    const other = fakeDb({ data: [row({ id: "theirs", resident_user_id: "u2", application_id: "AXIS-1", snapshot: { blocks: "lease_signing" } })] });
    expect((await loadResidentBlockingForms(other.db, { email: "a@example.test", userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] })).leaseSigning).toBe(false);

    const otherApplication = fakeDb({ data: [row({ id: "pending", resident_user_id: null, application_id: "AXIS-9", snapshot: { blocks: "lease_signing" } })] });
    expect((await loadResidentBlockingForms(otherApplication.db, { email: "a@example.test", userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] })).leaseSigning).toBe(false);

    const noScope = fakeDb({ data: [pendingRow] });
    expect((await loadResidentBlockingForms(noScope.db, { email: "a@example.test", userId: "u1" })).leaseSigning).toBe(false);
    expect(noScope.calls).toContainEqual(["eq", "resident_user_id", "u1"]);

    const harmless = fakeDb({ data: [row({ id: "pending", resident_user_id: null, application_id: "AXIS-1", snapshot: { kind: "other", blocks: "nothing" } })] });
    expect(await loadResidentBlockingForms(harmless.db, { email: "a@example.test", userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] }))
      .toMatchObject({ leaseSigning: false, approval: false, moveInDetails: false });
  });

  /**
   * `application_id` holds whatever spelling its row carried, and the DB filter is what actually
   * fetches an unbound row — so an exact `in` would be narrower than the in-memory test and the
   * restored gate would fail open again on a pre-rebrand id or a different case.
   */
  it.each([
    ["the lease's own spelling", "AXIS-1"],
    ["a pre-rebrand id against a rebranded lease", "AXIS-1", "PROPLANE-1"],
    ["a rebranded id against a pre-rebrand lease", "PROPLANE-1", "AXIS-1"],
    ["a lowercase stored id", "axis-1"],
    ["a lowercase lease id", "AXIS-1", "axis-1"],
  ])("matches %s", async (_label, storedId, leaseId = storedId) => {
    const { db, calls } = fakeDb({ data: [row({ id: "pending", resident_user_id: null, application_id: storedId, snapshot: { blocks: "lease_signing" } })] });
    expect((await loadResidentBlockingForms(db, { email: "a@example.test", userId: "u1", applicationIds: [leaseId], ownApplicationIds: [leaseId] })).leaseSigning).toBe(true);
    // Every id the in-memory test would keep is also in the filter, never an exact `in`. The filter
    // matches case-insensitively, so it is compared the same way.
    const expression = String(calls.find(([name]) => name === "or")?.[2] ?? "");
    expect(expression.toUpperCase()).toContain(`APPLICATION_ID.ILIKE."${storedId.toUpperCase()}"`);
    expect(expression).not.toContain("application_id.in.");
    // One term per normalized id: `ilike` already ignores case, so a second spelling of the same id
    // would only add an identical non-indexable term.
    const terms = expression.match(/application_id\.ilike\./g) ?? [];
    expect(terms).toHaveLength(2);
  });

  /**
   * An unbound row has no subject to pin, so the joint-member ids the lease carries must not reach
   * it: that form is one only the co-applicant can submit, and it is never even nameable, so
   * gating this resident on it would be a refusal they have no way to clear.
   */
  it("never lets a co-applicant's unbound form gate the other resident", async () => {
    const coApplicants = { axisId: "AXIS-MINE", jointLeaseMembers: [{ applicationId: "AXIS-THEIRS" }] };
    expect(leaseApplicationIds(coApplicants)).toEqual(["AXIS-MINE", "AXIS-THEIRS"]);
    expect(leaseOwnApplicationIds({ residentUserId: "u1", axisId: " AXIS-MINE " }, "u1")).toEqual(["AXIS-MINE"]);
    // The lease row belongs to the co-applicant, so it names no application for this login at all.
    expect(leaseOwnApplicationIds({ residentUserId: "u2", axisId: "AXIS-MINE" }, "u1")).toEqual([]);
    expect(leaseOwnApplicationIds({ residentUserId: "u1", axisId: "AXIS-MINE" }, "")).toEqual([]);
    expect(leaseOwnApplicationIds(null, "u1")).toEqual([]);

    const scope = {
      email: "a@example.test",
      userId: "u1",
      applicationIds: leaseApplicationIds(coApplicants),
      ownApplicationIds: leaseOwnApplicationIds({ residentUserId: "u1", axisId: coApplicants.axisId }, "u1"),
    };
    const theirs = fakeDb({ data: [row({ id: "theirs", resident_user_id: null, application_id: "AXIS-THEIRS", snapshot: { blocks: "lease_signing" } })] });
    expect((await loadResidentBlockingForms(theirs.db, scope)).leaseSigning).toBe(false);
    expect(String(theirs.calls.find(([name]) => name === "or")?.[2] ?? "")).not.toContain("AXIS-THEIRS");

    const ours = fakeDb({ data: [row({ id: "ours", resident_user_id: null, application_id: "axis-mine", snapshot: { blocks: "lease_signing" } })] });
    expect((await loadResidentBlockingForms(ours.db, scope)).leaseSigning).toBe(true);
  });

  it("a profile address that drifted from the Auth one cannot change what blocks", async () => {
    const rows = [row({ id: "pending", resident_user_id: null, application_id: "AXIS-1", snapshot: { blocks: "lease_signing" } })];
    for (const email of ["a@example.test", "drifted@example.test", ""]) {
      const { db } = fakeDb({ data: rows });
      expect((await loadResidentBlockingForms(db, { email, userId: "u1", applicationIds: ["AXIS-1"], ownApplicationIds: ["AXIS-1"] })).leaseSigning).toBe(true);
    }
  });

  it("a manager's read only counts forms the caller holds, and a scope check that throws fails closed", async () => {
    const rows = [
      row({ id: "mine", snapshot: { blocks: "approval" }, manager_user_id: "m1", property_id: "p1" }),
      row({ id: "theirs", snapshot: { blocks: "lease_signing" }, manager_user_id: "m2", property_id: "p2" }),
    ];
    const { db, selects } = fakeDb({ data: rows });
    const result = await loadResidentBlockingForms(db, { email: "a@example.test", callerHolds: async (form) => form.manager_user_id === "m1" });
    expect(result).toMatchObject({ approval: true, leaseSigning: false });
    expect(result.formIds).toEqual({ approval: "mine" });
    expect(selects[0]).toContain("manager_user_id, property_id");
    expect(await loadResidentBlockingForms(fakeDb({ data: rows }).db, { email: "a@example.test", callerHolds: async () => { throw new Error("scope down"); } })).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
    expect((await loadResidentBlockingForms(fakeDb({ data: rows }).db, { email: "a@example.test", callerHolds: async () => false }))).toMatchObject({ approval: false, leaseSigning: false });
  });

  it("with application ids, a form counts for the lease's property OR its application, never the property alone", async () => {
    const forms = [
      row({ id: "other-house-same-app", snapshot: { blocks: "lease_signing" }, property_id: "p9", application_id: "axis-1" }),
      row({ id: "other-house-other-app", snapshot: { blocks: "approval" }, property_id: "p9", application_id: "AXIS-2" }),
      row({ id: "same-house", snapshot: { blocks: "move_in_details" }, property_id: "p1", application_id: "AXIS-3" }),
    ];
    const { db, calls } = fakeDb({ data: forms });
    const result = await loadResidentBlockingForms(db, { email: "a@example.test", propertyId: "p1", applicationIds: ["AXIS-1"] });
    expect(result).toMatchObject({ leaseSigning: true, approval: false, moveInDetails: true });
    // The property narrowing moved in memory, so the DB read is not pinned to the property.
    expect(calls.some(([, column]) => column === "property_id")).toBe(false);
    expect(leaseApplicationIds({ axisId: " AXIS-1 ", jointLeaseMembers: [{ applicationId: "AXIS-2" }, { applicationId: "AXIS-1" }, { applicationId: "" }] })).toEqual(["AXIS-1", "AXIS-2"]);
    expect(leaseApplicationIds(undefined)).toEqual([]);
  });

  it("an application is read by every spelling of its id", async () => {
    const { db, calls } = fakeDb({ data: [row({ snapshot: { blocks: "approval" } })] });
    expect((await loadApplicationBlockingForms(db, ["AXIS-1", "axis-1", " "])).approval).toBe(true);
    expect(calls).toContainEqual(["in", "application_id", ["AXIS-1", "axis-1"]]);
  });

  // One error rule for every reader here: this table ships with the move-in form migrations, so an
  // unreadable one is an outage, not an environment without the feature.
  it.each([
    { code: "500", message: "boom" },
    { code: "42P01", message: 'relation "x" does not exist' },
    { code: "PGRST205", message: "Could not find the table in the schema cache" },
  ])("blocks on any read error ($code), a missing table included", async (error) => {
    expect(await loadResidentBlockingForms(fakeDb({ error }).db, { email: "a@example.test" })).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
    expect(await loadApplicationBlockingForms(fakeDb({ error }).db, "AXIS-1")).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
  });

  it("blocks when the read throws outright", async () => {
    expect(await loadResidentBlockingForms(fakeDb("throw").db, { email: "a@example.test" })).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
    expect(await loadApplicationBlockingForms(fakeDb("throw").db, "AXIS-1")).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
  });

  it("has nothing to look up without an email or an id", async () => {
    expect(await loadResidentBlockingForms(fakeDb({ data: [] }).db, { email: "  " })).toEqual(NO_BLOCKING_FORMS);
    expect(await loadApplicationBlockingForms(fakeDb({ data: [] }).db, [])).toEqual(NO_BLOCKING_FORMS);
  });

  it("marks a failed read as such, so a refusal can say 'could not check' instead of naming a form", async () => {
    expect((await loadResidentBlockingForms(fakeDb({ error: { code: "500", message: "boom" } }).db, { email: "a@example.test" })).readFailed).toBe(true);
    expect((await loadApplicationBlockingForms(fakeDb("throw").db, "AXIS-1")).readFailed).toBe(true);
    // A real block is not a failed read, and neither is a table that is not set up.
    expect((await loadApplicationBlockingForms(fakeDb({ data: [row({ snapshot: { blocks: "approval" } })] }).db, "AXIS-1")).readFailed).toBeUndefined();
    expect((await loadResidentBlockingForms(fakeDb({ error: { code: "42P01", message: 'relation "x" does not exist' } }).db, { email: "a@example.test" })).readFailed).toBe(true);
  });
});

/**
 * The resident portal's access state reads this table on EVERY page, so both facts it needs come from one
 * select of the non-cancelled copies (AGENTS.md § Performance & egress). The subject's bound
 * application ids come from one further read, which the forms select is then scoped by.
 */
describe("one read answers both resident forms facts", () => {
  /** The row shape the facts select actually returns: the two snapshot keys, projected out of the jsonb. */
  const factsRow = (patch: Record<string, unknown> = {}) => ({
    id: "r1", resident_user_id: "u1", form_id: "f1", status: "sent", sent_at: "2026-10-01T00:00:00Z", snapshot_kind: "other", snapshot_blocks: null, ...patch,
  });

  it("asks once, excluding cancelled copies, and derives hasForms and the blocks together", async () => {
    const { db, calls } = fakeDb({ data: [
      factsRow({ id: "mine", resident_user_id: "u1", snapshot_blocks: "approval" }),
      factsRow({ id: "done", resident_user_id: "u1", status: "submitted", snapshot_blocks: "lease_signing" }),
    ] });
    const facts = await loadResidentFormsFacts(db, { email: " A@Example.TEST ", userId: "u1" });
    expect(facts.hasForms).toBe(true);
    expect(facts.blocking).toMatchObject({ approval: true, leaseSigning: false, moveInDetails: false });
    expect(calls).toEqual([["neq", "status", "cancelled"], ["eq", "resident_user_id", "u1"]]);
  });

  /**
   * `blocking.moveInDetails` is what every move-in-details redaction keys on, so an unbound row has
   * to count here too — scoped to an application this login is bound to, never to an address, and
   * without unlocking the Forms section it still cannot open.
   */
  it("counts an unbound copy on an application this login is bound to, and nothing else", async () => {
    const pending = [factsRow({ id: "pending", resident_user_id: null, application_id: "axis-1", snapshot_kind: "intake", snapshot_blocks: "move_in_details" })];
    const SCOPED_OR = 'resident_user_id.eq.u1,and(resident_user_id.is.null,or(application_id.ilike."AXIS-1",application_id.ilike."PROPLANE-1"))';

    const byApplication = fakeDb({ data: pending }, { data: [{ id: "AXIS-1", row_id: "AXIS-1" }] });
    const locked = await loadResidentFormsFacts(byApplication.db, { email: "a@example.test", userId: "u1" });
    expect(locked.blocking.moveInDetails).toBe(true);
    expect(locked.blocking.formIds?.moveInDetails).toBeUndefined();
    expect(locked.hasForms).toBe(false);
    expect(byApplication.scopeCalls).toContainEqual(["eq", "row_data->>residentUserId", "u1"]);
    expect(byApplication.calls).toContainEqual(["or", "or", SCOPED_OR]);

    // The cohort that actually exists: the application never got a subject, but this login's own
    // signed lease names it. Without the lease arm this scope would be empty by construction.
    const byLease = fakeDb({ data: pending }, { data: [] }, { data: [{ row_data: { axisId: "AXIS-1" } }] });
    expect((await loadResidentFormsFacts(byLease.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(true);
    expect(byLease.scopeCalls).toContainEqual(["eq", "resident_user_id", "u1"]);
    expect(byLease.calls).toContainEqual(["or", "or", SCOPED_OR]);

    // Only the lease row's OWN primary application: a co-applicant's unbound form is one this
    // resident could never submit, so it must not lock them either.
    const byJointMember = fakeDb({ data: pending }, { data: [] }, { data: [{ row_data: { axisId: "AXIS-7", jointLeaseMembers: [{ applicationId: "proplane-1" }] } }] });
    expect((await loadResidentFormsFacts(byJointMember.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(false);
    expect(JSON.stringify(byJointMember.calls)).not.toContain("PROPLANE-1");

    const someoneElses = fakeDb({ data: pending }, { data: [{ id: "AXIS-9", row_id: "AXIS-9" }] }, { data: [{ row_data: { axisId: "AXIS-8" } }] });
    expect((await loadResidentFormsFacts(someoneElses.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(false);

    const unscoped = fakeDb({ data: pending }, { data: [] }, { data: [] });
    const open = await loadResidentFormsFacts(unscoped.db, { email: "a@example.test", userId: "u1" });
    expect(open.blocking.moveInDetails).toBe(false);
    expect(unscoped.calls).toContainEqual(["eq", "resident_user_id", "u1"]);

    // Never by address, at any of the three reads.
    for (const probe of [byApplication, byLease, byJointMember, someoneElses, unscoped]) {
      expect(JSON.stringify([...probe.calls, ...probe.scopeCalls])).not.toContain("resident_email");
    }
  });

  it("takes a scope its caller already read instead of scanning for it again", async () => {
    const pending = [factsRow({ id: "pending", resident_user_id: null, application_id: "axis-1", snapshot_kind: "intake", snapshot_blocks: "move_in_details" })];
    const handed = fakeDb({ data: pending }, "throw", "throw");
    expect((await loadResidentFormsFacts(handed.db, { email: "a@example.test", userId: "u1", boundApplicationIds: ["AXIS-1"] })).blocking.moveInDetails).toBe(true);
    expect(handed.scopeCalls).toEqual([]);

    // The caller saying "my own scope read failed" locks, it never reads as an empty scope.
    const failed = fakeDb({ data: pending });
    expect(await loadResidentFormsFacts(failed.db, { email: "a@example.test", userId: "u1", boundApplicationIds: null }))
      .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
  });

  it("fails closed on ANY read behind the answer, including a forms table that is not set up", async () => {
    const scopeFailures: FakeAnswer[] = [{ error: { code: "500", message: "boom" } }, "throw"];
    for (const failure of scopeFailures) {
      const pairs: Array<[FakeAnswer, FakeAnswer]> = [[failure, { data: [] }], [{ data: [] }, failure]];
      for (const [applications, leases] of pairs) {
        const { db } = fakeDb({ data: [] }, applications, leases);
        expect(await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" }))
          .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
      }
    }
    // Unlike the manager-facing readers, an unreadable or missing forms table is a LOCKED gate here:
    // this answer drives the move-in-details redaction, so it must never open on an error.
    for (const forms of [
      { error: { code: "500", message: "boom" } },
      { error: { code: "42P01", message: 'relation "x" does not exist' } },
      { error: { code: "PGRST205", message: "Could not find the table in the schema cache" } },
      "throw" as const,
    ]) {
      const { db } = fakeDb(forms);
      expect(await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" }))
        .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
    }
  });

  // Every resident page runs this read, so it must never drag the whole snapshot (questions + PDF
  // metadata) along for the two keys a block is derived from.
  it("selects only the columns it reads, projecting the two snapshot keys out of the jsonb", async () => {
    const { db, selects } = fakeDb({ data: [] });
    await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" });
    expect(selects).toHaveLength(1);
    expect(selects[0]).toBe("id, form_id, status, sent_at, resident_user_id, application_id, snapshot_kind:snapshot->>kind, snapshot_blocks:snapshot->>blocks");
    expect(selects[0]).not.toMatch(/(^|[ ,])snapshot([ ,]|$)/);
  });

  it("phone-only exact ownership blocks signing and excludes unbound historical copies", async () => {
    const { db, calls } = fakeDb({ data: [row({ resident_user_id: "u1", snapshot: { blocks: "lease_signing" } }), row({ resident_user_id: null, snapshot: { blocks: "approval" } })] });
    const result = await loadResidentBlockingForms(db, { email: "", userId: "u1" });
    expect(result).toMatchObject({ leaseSigning: true, approval: false });
    expect(calls).toContainEqual(["eq", "resident_user_id", "u1"]);
  });

  /**
   * No Auth subject is "unknown", never "nothing blocks". `LeaseSubject.residentUserId` is nullable
   * (`automations/moments.ts`), so a manager-onboarded or imported resident reaches
   * `loadMoveInDetailsLock` with none — and the `move_in_3d` automation reads
   * `moveInDetailsLocked` before it puts the door code, the Wi-Fi password and parking in a text
   * (`automations/sweep.server.ts`). Answering "not blocked" without reading the table at all
   * disclosed all four to someone who still owed an unsubmitted move-in form.
   */
  it("fails CLOSED with no subject, without reading the table at all", async () => {
    for (const userId of [undefined, null, ""]) {
      const { db, calls } = fakeDb({ data: [factsRow({ snapshot_blocks: "move_in_details" })] });
      expect(await loadResidentFormsFacts(db, { email: "a@example.test", userId }))
        .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
      expect(calls).toEqual([]);
    }
  });

  it("a copy tied to another login is neither a form of theirs nor a block", async () => {
    const { db } = fakeDb({ data: [factsRow({ id: "theirs", resident_user_id: "u2", snapshot_blocks: "approval" })] });
    const facts = await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" });
    expect(facts.hasForms).toBe(false);
    expect(facts.blocking).toMatchObject({ moveInDetails: false, leaseSigning: false, approval: false });
  });

  it("a submitted-only resident has forms but nothing blocked", async () => {
    const { db } = fakeDb({ data: [factsRow({ id: "done", status: "submitted", snapshot_kind: "intake" })] });
    const facts = await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" });
    expect(facts.hasForms).toBe(true);
    expect(facts.blocking).toMatchObject({ moveInDetails: false });
  });

  it("falls back to the kind's default, and to the form id when the snapshot has no kind", async () => {
    const intake = fakeDb({ data: [factsRow({ snapshot_kind: "intake" })] });
    expect((await loadResidentFormsFacts(intake.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(true);
    const byFormId = fakeDb({ data: [factsRow({ form_id: "default-intake", snapshot_kind: null })] });
    expect((await loadResidentFormsFacts(byFormId.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(true);
    const explicitNothing = fakeDb({ data: [factsRow({ snapshot_kind: "intake", snapshot_blocks: "nothing" })] });
    expect((await loadResidentFormsFacts(explicitNothing.db, { email: "a@example.test", userId: "u1" })).blocking.moveInDetails).toBe(false);
  });

  it("holds no form of its own without a login, and never claims a form exists on an error", async () => {
    // Without a subject the answer is "unknown", not "nothing blocks" (the fail-closed case above):
    // no form is theirs, and every block stays closed.
    expect(await loadResidentFormsFacts(fakeDb({ data: [] }).db, { email: " " })).toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
    expect((await loadResidentFormsFacts(fakeDb("throw").db, { email: "a@example.test", userId: "u1" })).hasForms).toBe(false);
  });
});
