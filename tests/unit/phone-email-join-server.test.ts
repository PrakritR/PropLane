import { beforeEach, describe, expect, it } from "vitest";
import {
  createPhoneEmailEvidenceCache,
  loadPhoneEmailEvidence,
  phoneDigitsLikePattern,
  resetInquiryEvidenceCache,
} from "@/lib/sms/phone-email-join.server";
import { emailForPhoneInWorkspace } from "@/lib/sms/phone-email-join";
import { INQUIRIES_RECORD_ID } from "@/lib/tour-inquiry.server";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type AppRow = { manager_user_id: string; resident_email: string; updated_at: string; phone: string | null; applicant_phone: string | null };

/** A db that applies the `or` ilike clauses like PostgREST would, and counts every read. */
function fakeDb(apps: AppRow[], inquiries: Record<string, unknown>[] = []) {
  const reads = { inquiries: 0, apps: 0, orClauses: [] as string[] };
  const db = {
    from(table: string) {
      if (table === "portal_schedule_records") {
        const b = {
          select: () => b,
          eq: (_c: string, id: string) => {
            expect(id).toBe(INQUIRIES_RECORD_ID);
            return b;
          },
          maybeSingle: async () => {
            reads.inquiries += 1;
            return { data: { row_data: { payload: inquiries } }, error: null };
          },
        };
        return b;
      }
      let owners: string[] = [];
      let pattern: RegExp[] = [];
      let from = 0;
      let to = 999;
      const b: Record<string, unknown> = {
        select: () => b,
        in: (_c: string, v: string[]) => ((owners = v), b),
        not: () => b,
        order: () => b,
        or: (clause: string) => {
          reads.orClauses.push(clause);
          pattern = [...new Set(clause.split(",").map((c) => c.split(".ilike.")[1]!))].map(
            (p) => new RegExp("^" + p.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i"),
          );
          return b;
        },
        range: (a: number, z: number) => ((from = a), (to = z), b),
        then: (resolve: (v: unknown) => unknown) => {
          reads.apps += 1;
          const rows = apps
            .filter((r) => owners.includes(r.manager_user_id))
            .filter((r) => pattern.some((re) => re.test(r.phone ?? "") || re.test(r.applicant_phone ?? "")))
            .slice(from, to + 1);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return b;
    },
  };
  return { db: db as never, reads };
}

beforeEach(() => resetInquiryEvidenceCache());

describe("phoneDigitsLikePattern", () => {
  it("matches any formatting of the same number", () => {
    const re = new RegExp("^" + phoneDigitsLikePattern("+16505129140")!.split("%").join(".*") + "$");
    for (const written of ["+16505129140", "(650) 512-9140", "650.512.9140", "1 650 512 9140"]) expect(re.test(written)).toBe(true);
    expect(re.test("(650) 512-9141")).toBe(false);
  });
});

describe("loadPhoneEmailEvidence", () => {
  it("sees a phone's second email even when thousands of newer unrelated rows exist", async () => {
    const noise: AppRow[] = Array.from({ length: 1500 }, (_, i) => ({
      manager_user_id: OWNER, resident_email: `n${i}@x.com`, updated_at: "2026-11-20", phone: `(415) 555-${String(i).padStart(4, "0")}`, applicant_phone: null,
    }));
    const apps: AppRow[] = [
      ...noise,
      { manager_user_id: OWNER, resident_email: "a@x.com", updated_at: "2026-01-01", phone: "(650) 512-9140", applicant_phone: null },
      { manager_user_id: OWNER, resident_email: "b@x.com", updated_at: "2025-01-01", phone: null, applicant_phone: "650-512-9140" },
    ];
    const { db } = fakeDb(apps);
    const evidence = await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140"]);
    expect(evidence.map((e) => e.email).sort()).toEqual(["a@x.com", "b@x.com"]);
    // Complete evidence means the ambiguity guard fires: two people on one handset join nothing.
    expect(emailForPhoneInWorkspace(evidence, OWNER, "+16505129140")).toBeNull();
  });

  it("filters the application read to the requested phones in SQL", async () => {
    const { db, reads } = fakeDb([]);
    await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140", "+14155550101"]);
    expect(reads.orClauses).toHaveLength(1);
    expect(reads.orClauses[0]).toContain("row_data->>phone.ilike.");
    expect(reads.orClauses[0]).toContain("row_data->>applicantPhone.ilike.");
  });

  it("reads the platform-wide inquiry blob once per TTL and only returns the asked owner's phones", async () => {
    const inquiries = [
      { phone: "+16505129140", email: "t@x.com", managerUserId: OWNER, createdAt: "2026-11-01T00:00:00Z" },
      { phone: "+16505129140", email: "elsewhere@x.com", managerUserId: OTHER, createdAt: "2026-11-01T00:00:00Z" },
    ];
    const { db, reads } = fakeDb([], inquiries);
    const first = await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140"]);
    const second = await loadPhoneEmailEvidence(db, [OTHER], ["+16505129140"]);
    expect(first.map((e) => e.email)).toEqual(["t@x.com"]);
    expect(second.map((e) => e.email)).toEqual(["elsewhere@x.com"]);
    expect(reads.inquiries).toBe(1);
  });

  it("reuses phones already read on an earlier page of the same request", async () => {
    const { db, reads } = fakeDb([{ manager_user_id: OWNER, resident_email: "a@x.com", updated_at: "2026-01-01", phone: "+16505129140", applicant_phone: null }]);
    const cache = createPhoneEmailEvidenceCache();
    await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140"], cache);
    await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140"], cache);
    expect(reads.apps).toBe(1);
    await loadPhoneEmailEvidence(db, [OWNER], ["+16505129140", "+14155550101"], cache);
    expect(reads.apps).toBe(2);
  });
});
