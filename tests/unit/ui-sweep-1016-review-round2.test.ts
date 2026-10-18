/**
 * Round-2 follow-ups on the Oct 16 sweep review. Each case pins the DECISION the captain made,
 * not the wording around it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("a refused draft discard puts the draft back", () => {
  it("restores that draft onto the latest rows, not the list from click time", () => {
    const source = read("src", "components", "portal", "pro-inbox.tsx");
    const fn = source.slice(source.indexOf("const discardActiveDraft = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, [activeThread, setReplyDraft, showToast]"));
    expect(body).toContain("runInboxMutation");
    expect(body).toContain("loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, [])");
    const failure = body.slice(body.indexOf("if (!saved)"));
    // The optimistic write committed `next` to memory. The revert re-reads storage
    // and `localRef` and puts only this thread's draft back, so a send, archive,
    // or inbound turn during the await is not replaced by the click-time list.
    expect(failure).toContain("localRef.current");
    expect(failure).toContain("restoreDiscardedDraftOnLatestRows(");
    expect(failure).toContain("stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, reverted)");
    expect(failure).toContain("setLocal(reverted)");
    expect(failure).not.toContain("stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, local)");
    expect(failure).not.toContain("setLocal(local)");
    expect(failure).toContain("restored.delete(threadId)");
    // The revert runs while the persist effect is still latched off.
    expect(body.indexOf("persistInboxRef.current = true")).toBeGreaterThan(body.indexOf("if (!saved)"));
  });

  it("discards a draft that exists only on screen, and clears the composer after that", () => {
    const source = read("src", "components", "portal", "pro-inbox.tsx");
    const fn = source.slice(source.indexOf("const discardActiveDraft = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, [activeThread, setReplyDraft, showToast]"));
    // Storage can lag React: the draft is written to state first, and
    // persistInbox no-ops while another mutation is in flight. The click was
    // allowed from that on-screen row, so a missing stored draft is not a no-op.
    expect(body).toContain("const onScreen = fromLocal?.aiDraft ? fromLocal : screenAtClick");
    expect(body).toContain("if (!stored?.aiDraft && !onScreen.aiDraft) return");
    expect(body).toContain("aiDraft: onScreen.aiDraft");
    const clearAt = body.indexOf('setReplyDraft("")');
    expect(clearAt).toBeGreaterThan(body.indexOf("if (!stored?.aiDraft && !onScreen.aiDraft) return"));
    expect(clearAt).toBeLessThan(body.indexOf("advanceInboxAiDraft"));
  });
});

describe("a blocked Generate lease says what is blocking it", () => {
  it("keeps the canonical word on the glyph and puts the reason on the accessible name", () => {
    const source = read("src", "components", "portal", "lease-primary-header-actions.tsx");
    expect(source).toContain("generateLeaseTitle");
    const icon = source.slice(source.indexOf("icon={FilePlus}"));
    const props = icon.slice(0, icon.indexOf("/>"));
    expect(props).toContain('label={generateLeaseBusy ? "Generating…" : "Generate lease"}');
    expect(props).toContain("`Generate lease — ${generateLeaseTitle.trim()}`");
    // `ariaLabel` overrides the accessible name while the tooltip still draws `label`, and a
    // disabled button carries the accessible name as its native title.
    expect(source).toContain("ariaLabel={ariaLabel}");
  });
});

describe("the admin Health household-source read has an index", () => {
  it("is partial on the one action it filters, and idempotent", () => {
    const migration = read("supabase", "migrations", "20261017130000_audit_log_household_source_review_index.sql");
    expect(migration).toContain("create index if not exists audit_log_household_source_review_idx");
    expect(migration).toContain("on public.audit_log (created_at desc)");
    expect(migration).toContain("where action = 'household_source_review'");
    // The route still reads that exact action, so the partial predicate matches the query.
    const route = read("src", "lib", "admin", "admin-health.server.ts");
    expect(route).toContain('.eq("action", HOUSEHOLD_SOURCE_REVIEW_ACTION)');
    expect(read("src", "lib", "household-source-review.server.ts")).toContain(
      'export const HOUSEHOLD_SOURCE_REVIEW_ACTION = "household_source_review"',
    );
  });
});

describe("the merged-conversation read settle never swallows its own read error", () => {
  it("logs a refused sibling select and stops, instead of reading it as no siblings", () => {
    const route = read("src", "app", "api", "portal-inbox-threads", "route.ts");
    const settle = route.slice(route.indexOf("async function settleCollapsedSiblingsRead"));
    const body = settle.slice(0, settle.indexOf("export async function GET"));
    expect(body).toContain("const { data, error: readError } = await query");
    expect(body).toContain('console.error("settleCollapsedSiblingsRead sibling read failed", readError)');
    // The bounded flips go out together rather than 50 sequential round trips inside the POST.
    expect(body).toContain("await Promise.all(");
    expect(body).toContain('db.rpc("mark_portal_inbox_thread_read_surgical"');
  });
});

describe("Add room never overwrites a sync, and never drops the form's own work", () => {
  it("three-way merges the form's answer, and every exit but Cancel commits it", () => {
    const panel = read("src", "components", "portal", "property-house-details-list-panel.tsx");
    expect(panel).toContain(
      "mergePendingAddSubmission({ base: pendingAdd.base, latest: sub, edited: payload.sub })",
    );
    // One commit path; Save and both navigations away go through it, Cancel does not.
    expect(panel.match(/commitEditor\(/g)?.length).toBe(3);
    for (const exit of ["onGoToBathrooms={(draft) => {", "onOpenLinkedRoom={(roomId, draft) => {"]) {
      const block = panel.slice(panel.indexOf(exit));
      expect(block.slice(0, block.indexOf("}}")), exit).toContain("if (!commitEditor(draft)) return;");
    }
    const close = panel.slice(panel.indexOf("const closeEditor = () => {"));
    expect(close.slice(0, close.indexOf("};"))).not.toContain("commitEditor");
  });

  it("drives the scalar skip and the row merge from one list of id-keyed keys", () => {
    const merge = read("src", "lib", "property-house-add-room.ts");
    expect(merge.match(/"rooms", "bathrooms", "sharedSpaces", "bundles", "customFees"/g)?.length).toBe(1);
    expect(merge).toContain("const ID_LIST_KEY_SET = new Set<string>(ID_LIST_KEYS)");
    expect(merge).toContain("for (const key of ID_LIST_KEYS) {");
    expect(merge).toContain("if (ID_LIST_KEY_SET.has(key)) continue;");
  });
});
