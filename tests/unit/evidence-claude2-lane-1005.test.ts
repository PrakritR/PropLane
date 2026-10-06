/**
 * EVIDENCE HARNESS for the two server-side promises of the claude-2 lane that have no screen of their
 * own, so a reviewer can read what the server actually answered instead of a green tick:
 *
 *   1. Closing Add property keeps a draft whose stays are not chosen yet — the empty lease-terms
 *      refusal applies to a listed/live write only (`property-records` POST).
 *   2. With "Full legal name" / "Email" removed from the template, the applicant's identity comes from
 *      the signed-in ACCOUNT, never the request body — a body-supplied email is ignored and marked as a
 *      mismatch (AGENTS.md: ids in a body are not authorization).
 *
 * Same contract as every other evidence-* harness: these are plain assertions, and the transcript files
 * are written only when EVIDENCE_DIR asks for them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
const say = (line: string) => transcript.push(line);
afterAll(() => {
  if (!EVIDENCE_DIR || transcript.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "server-transcript.txt"), `${transcript.join("\n")}\n`, "utf8");
});

const getUser = vi.fn();
let UPSERTS: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "pro" }),
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  sameApplicationFeeWaiverCodeText: () => true,
  previewApplicationFeeWaiverCodeWrite: async () => ({ ok: true }),
  upsertPropertyApplicationFeeWaiverCode: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "portal_workspaces") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
      }
      return {
        select: (_cols: string, opts?: { count?: string }) => {
          if (!opts?.count) return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
          const builder = {
            eq: () => builder,
            in: () => builder,
            neq: () => builder,
            then(resolve: (v: { count: number | null; error: unknown }) => unknown) {
              return Promise.resolve({ count: 0, error: null }).then(resolve);
            },
          };
          return builder;
        },
        upsert: async (row: Record<string, unknown>) => {
          UPSERTS.push(row);
          return { error: null };
        },
      };
    },
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";
import { resolveApplicantIdentity } from "@/lib/rental-application/applicant-identity";

const MANAGER = "mgr-evidence-1";

async function post(status: string) {
  const body = {
    action: "upsert",
    id: `mgr-evidence-house-${status}`,
    managerUserId: MANAGER,
    status,
    // Exactly what closing Add property sends before the manager has ticked a stay.
    rowData: { submission: { buildingName: "412 Maple Street", allowedLeaseTerms: [], shortTermRentalsAllowed: false } },
  };
  const res = await postPropertyRecord(jsonRequest("http://localhost/api/property-records", { method: "POST", body }));
  const json = (await res.clone().json()) as Record<string, unknown>;
  say(`POST /api/property-records  status=${status}  allowedLeaseTerms=[]`);
  say(`  -> HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  say(`  -> rows written: ${UPSERTS.length}`);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
});

describe("closing Add property keeps a draft whose stays are not chosen yet", () => {
  it("a draft with no stay chosen is saved; the same payload as a live listing is refused", async () => {
    say("=== (5) empty lease terms: refusal is for a non-draft write only ===");
    const draft = await post("draft");
    expect(draft.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);

    UPSERTS = [];
    const live = await post("live");
    expect(live.status).toBe(400);
    expect(UPSERTS).toHaveLength(0);
    say("");
  });
});

describe("with the name / email questions removed, identity comes from the account", () => {
  it("ignores a body-supplied email in favour of the signed-in one and records the mismatch", () => {
    say("=== (4) applicant identity when the template has no Full legal name / Email question ===");

    const signedIn = resolveApplicantIdentity({
      answers: {},
      authUser: { email: "Jane.Doe@Example.com" },
      profile: { full_name: "Jane Account" },
    });
    say("signed-in applicant, no answers in the body:");
    say(`  stored name  = ${JSON.stringify(signedIn.name)} (source: ${signedIn.nameSource})`);
    say(`  stored email = ${JSON.stringify(signedIn.email)} (source: ${signedIn.emailSource})`);
    expect(signedIn).toMatchObject({ name: "Jane Account", email: "jane.doe@example.com", emailSource: "account" });

    const spoofed = resolveApplicantIdentity({
      answers: { email: "mallory@evil.test", fullLegalName: "Mallory" },
      authUser: { email: "jane@example.com" },
      profile: { full_name: "Jane Account" },
    });
    say('body claims email "mallory@evil.test" while signed in as jane@example.com:');
    say(`  stored email = ${JSON.stringify(spoofed.email)}  (mismatch flagged: ${spoofed.emailMismatch})`);
    expect(spoofed.email).toBe("jane@example.com");
    expect(spoofed.emailMismatch).toBe(true);

    const guest = resolveApplicantIdentity({ answers: { email: "Guest@Example.com" }, authUser: null });
    say("signed-out guest (always asked who they are):");
    say(`  stored email = ${JSON.stringify(guest.email)} (source: ${guest.emailSource})`);
    expect(guest).toMatchObject({ email: "guest@example.com", emailSource: "answer" });
    say("");
  });
});
