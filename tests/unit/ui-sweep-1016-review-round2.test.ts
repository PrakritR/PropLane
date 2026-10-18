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
  it("restores the rows on screen and in the local cache, not just the latched id", () => {
    const source = read("src", "components", "portal", "pro-inbox.tsx");
    const fn = source.slice(source.indexOf("const discardActiveDraft = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, [activeThread, local"));
    const failure = body.slice(body.indexOf("if (!saved)"));
    // The optimistic write committed `next` to memory, so the revert has to re-commit `local`.
    expect(failure).toContain("stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, local)");
    expect(failure).toContain("setLocal(local)");
    expect(failure).toContain("restored.delete(activeThread.id)");
    // The revert runs while the persist effect is still latched off.
    expect(body.indexOf("persistInboxRef.current = true")).toBeGreaterThan(body.indexOf("if (!saved)"));
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

describe("Add room never overwrites a sync", () => {
  it("merges the new room onto the live listing on Save and drops it when navigating away", () => {
    const panel = read("src", "components", "portal", "property-house-details-list-panel.tsx");
    expect(panel).toContain("mergeAddedRoomIntoLatest(sub, payload.sub, pendingAdd.roomId)");
    const linked = panel.slice(panel.indexOf("onOpenLinkedRoom={(roomId) => {"));
    expect(linked.slice(0, linked.indexOf("}}"))).toContain(
      "if (pendingAdd && pendingAdd.roomId !== roomId) setPendingAdd(null)",
    );
  });
});
