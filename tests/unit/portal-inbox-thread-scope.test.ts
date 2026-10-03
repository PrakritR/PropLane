import { describe, expect, it } from "vitest";
import { portalInboxThreadScopeFilter } from "@/lib/portal-inbox-thread-scope";
import { parseOrFilterClauses } from "@/lib/supabase/or-filter";

describe("portalInboxThreadScopeFilter", () => {
  it("includes owner and participant for managers", () => {
    expect(portalInboxThreadScopeFilter({ id: "mgr-1", email: "mgr@example.com", role: "manager" })).toBe(
      'owner_user_id.eq."mgr-1",participant_email.eq."mgr@example.com"',
    );
  });

  it("includes extra co-manager owner ids as an in() clause", () => {
    expect(
      portalInboxThreadScopeFilter({ id: "co-1", email: "co@example.com", role: "manager" }, ["owner-1"]),
    ).toBe('owner_user_id.in.("co-1","owner-1"),participant_email.eq."co@example.com"');
  });

  it("for manager Communication, matches the viewer's email only on legacy owner-less rows", () => {
    // A thread another owner holds never reaches a manager's inbox because the
    // manager is the person it was sent to — that owner never invited them.
    expect(
      portalInboxThreadScopeFilter({ id: "mgr-1", email: "mgr@example.com", role: "manager" }, [], {
        participantOnlyWhenUnowned: true,
      }),
    ).toBe('owner_user_id.eq."mgr-1",and(owner_user_id.is.null,participant_email.eq."mgr@example.com")');
  });

  it("omits empty participant_email clause", () => {
    expect(portalInboxThreadScopeFilter({ id: "mgr-1", email: null, role: "manager" })).toBe('owner_user_id.eq."mgr-1"');
  });

  it("lets admins write manager-owned rows and admin-scope rows", () => {
    expect(portalInboxThreadScopeFilter({ id: "admin-1", email: "admin@example.com", role: "admin" })).toBe(
      'owner_user_id.eq."admin-1",participant_email.eq."admin@example.com",scope.eq.admin',
    );
  });

  it("quotes an email so a comma or paren in it cannot add a clause (S12)", () => {
    const evil = 'x@y.test",owner_user_id.neq.zzz,"a';
    const filter = portalInboxThreadScopeFilter({ id: "mgr-1", email: evil, role: "manager" });
    const clauses = parseOrFilterClauses(filter);
    expect(clauses).toEqual([
      { column: "owner_user_id", operator: "eq", value: "mgr-1" },
      { column: "participant_email", operator: "eq", value: evil },
    ]);
  });
});
