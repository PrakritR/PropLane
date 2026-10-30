import { describe, expect, it } from "vitest";
import catalog from "../e2e/support/draft-fk-catalog.json";
import { preflightSyntheticWorkspace } from "../helpers/synthetic-workspace-preflight";
const input = { authId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", smsId: "33333333-3333-4333-8333-333333333333", smsMissing: false, workspaceMissing: false };
function fixture({ extra = false, drift = false, smsMissing = false, workspaceMissing = false } = {}) {
  return { async query(sql: string) {
    if (sql.includes("select id,owner_user_id")) return { rows: workspaceMissing ? [] : [{ owner_user_id: drift ? input.smsId : input.authId, is_default: true, is_service: false }] };
    if (sql.includes("manager_sms_numbers'::regclass")) return { rows: [] };
    if (sql.includes("pg_constraint")) return { rows: catalog.rows };
    if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "manager_sms_numbers" }, { table_name: "listing_channel_posts" }] };
    if (sql.includes("select id::text")) return { rows: smsMissing ? [] : [{ manager_user_id: input.authId, workspace_id: input.workspaceId }] };
    const sms = sql.includes('public."manager_sms_numbers"');
    const other = sql.includes('public."listing_channel_posts"');
    return { rows: [{ count: sms && !smsMissing ? 1 : other && extra ? 1 : 0 }] };
  } };
}
describe("synthetic workspace preflight", () => {
  it("accepts only the expected pending SMS descendant", async () => { await expect(preflightSyntheticWorkspace(fixture(), input)).resolves.toBeUndefined(); });
  it("denies changed owner and unexpected non-FK reference", async () => {
    await expect(preflightSyntheticWorkspace(fixture({ drift: true }), input)).rejects.toThrow();
    await expect(preflightSyntheticWorkspace(fixture({ extra: true }), input)).rejects.toThrow();
  });
  it("checks the post-deletion stage", async () => { await expect(preflightSyntheticWorkspace(fixture({ smsMissing: true, workspaceMissing: true }), { ...input, smsMissing: true, workspaceMissing: true })).resolves.toBeUndefined(); });
});
