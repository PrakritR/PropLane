import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import { ALL_RECORD_KINDS, recordSections, RECORD_TRIO_IDS } from "@/lib/portals/record-sections";

/**
 * The registry is the single place every record page's rail and header
 * actions come from (PLAN-0920-1058, area 1a). Two invariants matter more
 * than any individual kind's exact section list: the shared trio is always
 * appended by the registry itself, and every href it hands out resolves to a
 * real route — a section that links nowhere is worse than no section.
 */
describe("record-sections registry", () => {
  it("covers every role/kind the rail table lists", () => {
    const pairs = ALL_RECORD_KINDS.map(({ role, kind }) => `${role}/${kind}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "manager/property",
        "manager/resident",
        "manager/payment",
        "manager/outgoing-payment",
        "manager/lease",
        "manager/application",
        "manager/inspection",
        "manager/service",
        "manager/task",
        "manager/vendor",
        "manager/tour",
        "manager/booking",
        "manager/document",
        "resident/payment",
        "resident/lease",
        "resident/service",
        "resident/inspection",
        "resident/document",
        "vendor/job",
        "vendor/invoice",
        "vendor/payout",
      ]),
    );
  });

  it.each(ALL_RECORD_KINDS)("$role/$kind ends with the trio, communication always present", ({ role, kind }) => {
    const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
    const allIds = sections.groups.flatMap((group) => group.items.map((item) => item.id));
    // Communication is unconditional; a kind may omit documents and/or
    // activity (Task and Tour skip documents; several resident/vendor kinds
    // skip both), but never reorders the trio relative to its own sections.
    expect(allIds).toContain("communication");
    const trioIdsPresent = allIds.filter((id) => (RECORD_TRIO_IDS as readonly string[]).includes(id));
    const ownIds = allIds.filter((id) => !(RECORD_TRIO_IDS as readonly string[]).includes(id));
    // Every trio id present appears strictly after every own id.
    const lastOwnIndex = Math.max(-1, ...ownIds.map((id) => allIds.indexOf(id)));
    const firstTrioIndex = trioIdsPresent.length ? Math.min(...trioIdsPresent.map((id) => allIds.indexOf(id))) : Infinity;
    expect(firstTrioIndex).toBeGreaterThan(lastOwnIndex);
  });

  it.each(ALL_RECORD_KINDS)("$role/$kind has unique section ids", ({ role, kind }) => {
    const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
    const allIds = sections.groups.flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it.each(ALL_RECORD_KINDS)("$role/$kind: every section href resolves to a route under src/app", ({ role, kind }) => {
    const basePath = role === "manager" ? "/portal" : `/${role}`;
    const sections = recordSections(role, kind, { basePath });
    for (const group of sections.groups) {
      for (const item of group.items) {
        const href = item.href("rec_123");
        expect(routeResolves(href), `${role}/${kind} section "${item.id}" -> ${href}`).toBe(true);
      }
    }
  });

  it.each(ALL_RECORD_KINDS)("$role/$kind: a phonePrimary id names a real header action", ({ role, kind }) => {
    const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
    if (!sections.phonePrimary) return;
    expect(sections.headerActions.some((action) => action.id === sections.phonePrimary)).toBe(true);
  });

  it("throws on an unregistered kind rather than silently returning nothing", () => {
    expect(() => recordSections("manager", "not-a-real-kind")).toThrow();
  });

  it("groups have no duplicate labels other than the unlabeled trio group", () => {
    for (const { role, kind } of ALL_RECORD_KINDS) {
      const sections = recordSections(role, kind, { basePath: `/${role === "manager" ? "portal" : role}` });
      const labels = sections.groups.map((g) => g.label).filter((label) => label !== "");
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
