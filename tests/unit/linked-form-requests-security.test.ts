import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";

/**
 * Linked-form share links hand a form to whoever opens them. These are the properties that make that safe, and
 * none of them shows up in a build or a render test. Same style as `invite-link-security.test.ts`.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const MIGRATION = read("supabase/migrations/20261004130000_linked_form_requests.sql");
const SERVER = read("src/lib/application-linked-form-requests.server.ts");
const REDEEM = read("src/app/api/linked-form-requests/redeem/route.ts");
const ITEM_ROUTE = read("src/app/api/linked-form-requests/[id]/route.ts");
const LIST_ROUTE = read("src/app/api/linked-form-requests/route.ts");
const COSIGNER_ROUTE = read("src/app/api/public/cosigner-submissions/route.ts");

describe("the plaintext token is never stored or read back", () => {
  it("stores only a SHA-256 hash, unique, with a 30-day expiry", () => {
    expect(MIGRATION).toMatch(/token_hash text not null unique/);
    expect(MIGRATION).not.toMatch(/^\s+token text/m);
    expect(MIGRATION).toContain("interval '30 days'");
    expect(SERVER).toContain('createHash("sha256")');
    expect(SERVER).toContain('randomBytes(TOKEN_BYTES)');
    expect(SERVER).toContain("const TOKEN_BYTES = 32");
  });

  it("never selects the hash for a response", () => {
    const columns = SERVER.match(/LINKED_FORM_REQUEST_COLUMNS =\s*"([^"]+)"/)?.[1] ?? "";
    expect(columns).not.toContain("token");
    expect(LIST_ROUTE).not.toMatch(/token_hash/);
    expect(ITEM_ROUTE).not.toMatch(/token_hash/);
  });
});

describe("the public schema is not a write surface", () => {
  it("enables RLS on both tables and grants client roles nothing but SELECT", () => {
    expect(MIGRATION).toContain("alter table public.application_form_requests enable row level security");
    expect(MIGRATION).toContain("alter table public.resident_account_links enable row level security");
    expect(MIGRATION).toContain("revoke all on public.application_form_requests from anon, authenticated");
    expect(MIGRATION).toContain("revoke all on public.resident_account_links from anon, authenticated");
    expect(MIGRATION).not.toMatch(/grant\s+(insert|update|delete|all)/i);
  });

  it("writes no permissive policy that is not a SELECT", () => {
    const policies = [...MIGRATION.matchAll(/create policy\s+(\w+)\s+on\s+public\.(\w+)\s+((?:as restrictive\s+)?for\s+\w+)/gi)];
    expect(policies.length).toBeGreaterThanOrEqual(3);
    for (const [, name, , clause] of policies) {
      const restrictive = /restrictive/i.test(clause!);
      if (!restrictive) expect(clause, `${name} must be a SELECT policy`).toMatch(/for select/i);
    }
  });

  it("grants SELECT on every column except token_hash", () => {
    const grant = /grant select \(([\s\S]*?)\) on public\.application_form_requests to authenticated/.exec(MIGRATION)?.[1] ?? "";
    expect(grant).toContain("manager_user_id");
    expect(grant).toContain("status");
    expect(grant).not.toContain("token_hash");
    expect(grant).not.toContain("fee_session_id");
  });

  it("lets a manager read only their own rows, and an applicant or helper only theirs", () => {
    expect(MIGRATION).toMatch(/application_form_requests_manager_read[\s\S]*manager_user_id = auth\.uid\(\)/);
    expect(MIGRATION).toMatch(/application_form_requests_applicant_read[\s\S]*applicant_user_id = auth\.uid\(\)[\s\S]*helper_user_id = auth\.uid\(\)/);
    expect(MIGRATION).toMatch(/resident_account_links_party_read[\s\S]*helper_user_id = auth\.uid\(\)/);
  });

  it("keeps one link per applicant, helper and application", () => {
    expect(MIGRATION).toMatch(/unique \(applicant_user_id, helper_user_id, application_id\)/);
    expect(MIGRATION).toMatch(/unique index if not exists application_form_requests_application_form_uidx/);
  });

  it("is idempotent", () => {
    expect(MIGRATION).not.toMatch(/create table\s+(?!if not exists)/i);
    expect(MIGRATION).not.toMatch(/create (unique )?index\s+(?!if not exists)/i);
    for (const match of MIGRATION.matchAll(/create policy\s+(\w+)\s+on\s+(public\.\w+)/gi)) {
      expect(MIGRATION).toContain(`drop policy if exists ${match[1]} on ${match[2]}`);
    }
  });
});

describe("the account purge knows both tables", () => {
  it("classifies both and detaches a helper rather than deleting the applicant's form", () => {
    const requests = ACCOUNT_PURGE_TABLES.find((rule) => rule.table === "application_form_requests");
    const links = ACCOUNT_PURGE_TABLES.find((rule) => rule.table === "resident_account_links");
    expect(requests?.manager?.ids).toContain("manager_user_id");
    expect(requests?.resident?.ids).toContain("applicant_user_id");
    expect(requests?.resident?.detachIds).toEqual(expect.arrayContaining(["helper_user_id", "filled_by_user_id", "fee_paid_by_user_id"]));
    expect(links?.resident?.ids).toEqual(expect.arrayContaining(["applicant_user_id", "helper_user_id"]));
  });
});

describe("routes re-derive access and name nothing", () => {
  it("the redeem body carries only the token and refuses every failure with the same answer", () => {
    expect(REDEEM).toContain("const REFUSED");
    expect(REDEEM).toMatch(/body\.token/);
    expect(REDEEM).not.toMatch(/body\.(applicationId|requestId|managerUserId|userId)/);
    expect(REDEEM).toContain("authorizeResidentRole");
    expect(REDEEM).toMatch(/rateLimit\(`linked-form-redeem:/);
  });

  it("every item action authorizes from the stored request, never the body", () => {
    expect(ITEM_ROUTE).toContain("resolveLinkedFormViewerRole");
    expect(ITEM_ROUTE).not.toMatch(/body\.(applicationId|managerUserId|userId|role)/);
    expect(ITEM_ROUTE).toContain("const NOT_FOUND");
  });

  it("the submit route takes the application and form from the request, and never trusts the body for them", () => {
    expect(COSIGNER_ROUTE).toContain("linkedRequest.application_id");
    expect(COSIGNER_ROUTE).toContain("linkedRequest.form_id");
    expect(COSIGNER_ROUTE).toContain("anyPublishedVariant: Boolean(linkedRequest)");
  });

  it("no URL ever carries personal data: the link is a path segment and the fee return carries only a Stripe session id", () => {
    const fee = read("src/lib/linked-form-fee.server.ts");
    expect(fee).toContain("fee_session_id={CHECKOUT_SESSION_ID}");
    expect(fee).not.toMatch(/successUrl:[^\n]*(email|name|ssn)/i);
  });
});
