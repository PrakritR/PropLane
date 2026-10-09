/**
 * Admin agent: account lookups. Read-only. Both tools call the functions the
 * admin Accounts list and account record already use, and project only
 * non-secret fields (no phone numbers, no tokens, no Stripe account ids).
 */
import { z } from "zod";
import { profileSearchFilter, resolveAccountKinds, scanNewestProfiles } from "@/lib/admin/admin-accounts.server";
import { isAdminAccountId, loadAdminAccountDetail } from "@/lib/admin/admin-account-detail.server";
import { defineTool } from "../registry";
import type { AdminAgentContext } from "./context";

const FIND_ACCOUNT_LIMIT = 10;

export const findAccountTool = defineTool({
  name: "find_account",
  description:
    "Search PropLane accounts (managers, residents, vendors) by name, email or PropLane ID. Returns up to 10 matches, newest first, each with its account id and kinds. Use the id with account_summary.",
  inputSchema: z.object({
    query: z.string().trim().min(2).max(120).describe("Part of a name, email or PropLane ID."),
  }),
  async handler(ctx: AdminAgentContext, input) {
    const match = profileSearchFilter(input.query);
    const found = await scanNewestProfiles(ctx.db, { match, limit: FIND_ACCOUNT_LIMIT }, async (rows) => {
      const kindsById = await resolveAccountKinds(ctx.db, rows);
      return rows
        .filter((row) => kindsById.has(row.id))
        .map((row) => ({
          id: row.id,
          name: row.full_name?.trim() || row.email || "",
          email: row.email ?? "",
          propLaneId: row.manager_id ?? "",
          kinds: kindsById.get(row.id) ?? [],
          active: row.application_approved !== false,
          joinedAt: row.created_at ?? null,
        }));
    });
    const accounts = found.slice(0, FIND_ACCOUNT_LIMIT);
    return { count: accounts.length, accounts };
  },
});

export const accountSummaryTool = defineTool({
  name: "account_summary",
  description:
    "One account in brief: roles, status, sign-in, plan (managers), workspaces, whether payouts are connected, and recent feedback. Takes the account id from find_account.",
  inputSchema: z.object({
    accountId: z.string().trim().describe("The account id (a UUID) from find_account."),
  }),
  async handler(ctx: AdminAgentContext, input) {
    if (!isAdminAccountId(input.accountId)) throw new Error("accountId must be an account id returned by find_account.");
    const detail = await loadAdminAccountDetail(ctx.db, input.accountId.trim());
    if (!detail) throw new Error("No account with that id.");
    return {
      id: detail.id,
      name: detail.fullName,
      email: detail.email,
      propLaneId: detail.propLaneId,
      roles: detail.roles,
      status: detail.status,
      createdAt: detail.createdAt,
      lastSignInAt: detail.lastSignInAt,
      plan: detail.manager ? { tier: detail.manager.tier, billing: detail.manager.billing } : null,
      workspaces: detail.workspaces.owned.map((w) => ({
        name: w.name,
        isDefault: w.isDefault,
        payoutsEnabled: w.payoutsEnabled,
      })),
      payoutsConnected: detail.payments.connectLinked,
      openDisputes: detail.payments.disputes.filter((d) => !/won|lost|closed/i.test(d.status)).length,
      recentFeedback: detail.support.feedback.slice(0, 5).map((f) => ({
        title: f.title,
        status: f.status,
        createdAt: f.createdAt,
      })),
    };
  },
});
