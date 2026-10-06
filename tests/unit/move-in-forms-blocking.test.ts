import { describe, expect, it } from "vitest";
import {
  blockingFormsFromRows,
  BLOCKING_FORMS_FAIL_CLOSED,
  loadApplicationBlockingForms,
  loadResidentBlockingForms,
  loadResidentFormsFacts,
  NO_BLOCKING_FORMS,
} from "@/lib/move-in-forms/blocking";
import { defaultMoveInFormBlocks, resolveMoveInFormBlocks } from "@/lib/move-in-forms/types";
import { normalizeMoveInFormTemplates } from "@/lib/move-in-forms/templates";

const row = (patch: Record<string, unknown> = {}) => ({
  id: "r1", form_id: "f1", status: "sent", sent_at: "2026-10-01T00:00:00Z", snapshot: { kind: "other" as const }, ...patch,
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

/** A one-table fake: records the filters it was asked for and answers with `result`. */
function fakeDb(result: { data?: unknown[]; error?: { code?: string; message?: string } | null } | "throw") {
  const calls: Array<[string, string, unknown]> = [];
  const selects: string[] = [];
  const query: Record<string, unknown> = {};
  const chain = (name: string) => (column: string, value: unknown) => { calls.push([name, column, value]); return query; };
  query.select = (columns: string) => { selects.push(columns); return query; };
  query.eq = chain("eq");
  query.neq = chain("neq");
  query.in = chain("in");
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    (result === "throw" ? Promise.reject(new Error("down")) : Promise.resolve({ data: result.data ?? null, error: result.error ?? null })).then(resolve, reject);
  return { db: { from: () => query } as never, calls, selects };
}

describe("loading what a resident or an application is blocked on", () => {
  it("reads a resident's SENT copies by login email, honours the login a copy is tied to, and can narrow to one house", async () => {
    const { db, calls } = fakeDb({ data: [
      row({ id: "mine", resident_user_id: "u1", snapshot: { blocks: "lease_signing" } }),
      row({ id: "theirs", resident_user_id: "u2", snapshot: { blocks: "approval" } }),
    ] });
    const result = await loadResidentBlockingForms(db, { email: " A@Example.TEST ", userId: "u1", propertyId: "p1" });
    expect(result).toMatchObject({ leaseSigning: true, approval: false });
    expect(calls).toEqual(expect.arrayContaining([["eq", "resident_email", "a@example.test"], ["eq", "status", "sent"], ["eq", "property_id", "p1"]]));
  });

  it("an application is read by every spelling of its id", async () => {
    const { db, calls } = fakeDb({ data: [row({ snapshot: { blocks: "approval" } })] });
    expect((await loadApplicationBlockingForms(db, ["AXIS-1", "axis-1", " "])).approval).toBe(true);
    expect(calls).toContainEqual(["in", "application_id", ["AXIS-1", "axis-1"]]);
  });

  it("fails closed on a read error, and treats a table that is not set up as nothing blocked", async () => {
    expect((await loadResidentBlockingForms(fakeDb({ error: { code: "500", message: "boom" } }).db, { email: "a@example.test" }))).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
    expect((await loadApplicationBlockingForms(fakeDb("throw").db, "AXIS-1"))).toEqual(BLOCKING_FORMS_FAIL_CLOSED);
    expect((await loadResidentBlockingForms(fakeDb({ error: { code: "42P01", message: 'relation "x" does not exist' } }).db, { email: "a@example.test" }))).toEqual(NO_BLOCKING_FORMS);
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
    expect((await loadResidentBlockingForms(fakeDb({ error: { code: "42P01", message: 'relation "x" does not exist' } }).db, { email: "a@example.test" })).readFailed).toBeUndefined();
  });
});

/**
 * The resident portal's access state reads this table on EVERY page, so both facts it needs come from one
 * select of the non-cancelled copies (AGENTS.md § Performance & egress).
 */
describe("one read answers both resident forms facts", () => {
  /** The row shape the facts select actually returns: the two snapshot keys, projected out of the jsonb. */
  const factsRow = (patch: Record<string, unknown> = {}) => ({
    id: "r1", form_id: "f1", status: "sent", sent_at: "2026-10-01T00:00:00Z", snapshot_kind: "other", snapshot_blocks: null, ...patch,
  });

  it("asks once, excluding cancelled copies, and derives hasForms and the blocks together", async () => {
    const { db, calls } = fakeDb({ data: [
      factsRow({ id: "mine", resident_user_id: "u1", snapshot_blocks: "approval" }),
      factsRow({ id: "done", resident_user_id: "u1", status: "submitted", snapshot_blocks: "lease_signing" }),
    ] });
    const facts = await loadResidentFormsFacts(db, { email: " A@Example.TEST ", userId: "u1" });
    expect(facts.hasForms).toBe(true);
    expect(facts.blocking).toMatchObject({ approval: true, leaseSigning: false, moveInDetails: false });
    expect(calls).toEqual([["eq", "resident_email", "a@example.test"], ["neq", "status", "cancelled"]]);
  });

  // Every resident page runs this read, so it must never drag the whole snapshot (questions + PDF
  // metadata) along for the two keys a block is derived from.
  it("selects only the columns it reads, projecting the two snapshot keys out of the jsonb", async () => {
    const { db, selects } = fakeDb({ data: [] });
    await loadResidentFormsFacts(db, { email: "a@example.test" });
    expect(selects).toHaveLength(1);
    expect(selects[0]).toBe("id, form_id, status, sent_at, resident_user_id, snapshot_kind:snapshot->>kind, snapshot_blocks:snapshot->>blocks");
    expect(selects[0]).not.toMatch(/(^|[ ,])snapshot([ ,]|$)/);
  });

  it("a copy tied to another login is neither a form of theirs nor a block", async () => {
    const { db } = fakeDb({ data: [factsRow({ id: "theirs", resident_user_id: "u2", snapshot_blocks: "approval" })] });
    const facts = await loadResidentFormsFacts(db, { email: "a@example.test", userId: "u1" });
    expect(facts.hasForms).toBe(false);
    expect(facts.blocking).toMatchObject({ moveInDetails: false, leaseSigning: false, approval: false });
  });

  it("a submitted-only resident has forms but nothing blocked", async () => {
    const { db } = fakeDb({ data: [factsRow({ id: "done", status: "submitted", snapshot_kind: "intake" })] });
    const facts = await loadResidentFormsFacts(db, { email: "a@example.test" });
    expect(facts.hasForms).toBe(true);
    expect(facts.blocking).toMatchObject({ moveInDetails: false });
  });

  it("falls back to the kind's default, and to the form id when the snapshot has no kind", async () => {
    const intake = fakeDb({ data: [factsRow({ snapshot_kind: "intake" })] });
    expect((await loadResidentFormsFacts(intake.db, { email: "a@example.test" })).blocking.moveInDetails).toBe(true);
    const byFormId = fakeDb({ data: [factsRow({ form_id: "default-intake", snapshot_kind: null })] });
    expect((await loadResidentFormsFacts(byFormId.db, { email: "a@example.test" })).blocking.moveInDetails).toBe(true);
    const explicitNothing = fakeDb({ data: [factsRow({ snapshot_kind: "intake", snapshot_blocks: "nothing" })] });
    expect((await loadResidentFormsFacts(explicitNothing.db, { email: "a@example.test" })).blocking.moveInDetails).toBe(false);
  });

  it("fails closed on a read error without claiming a form exists; a missing table blocks nothing", async () => {
    expect(await loadResidentFormsFacts(fakeDb({ error: { code: "500", message: "boom" } }).db, { email: "a@example.test" }))
      .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
    expect(await loadResidentFormsFacts(fakeDb("throw").db, { email: "a@example.test" }))
      .toEqual({ hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED });
    expect(await loadResidentFormsFacts(fakeDb({ error: { code: "42P01", message: 'relation "x" does not exist' } }).db, { email: "a@example.test" }))
      .toEqual({ hasForms: false, blocking: NO_BLOCKING_FORMS });
    expect(await loadResidentFormsFacts(fakeDb({ data: [] }).db, { email: " " })).toEqual({ hasForms: false, blocking: NO_BLOCKING_FORMS });
  });
});
