import { createJsonRecordRoute } from "@/lib/portal-record-api";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

export const runtime = "nodejs";

function feedbackType(row: Record<string, unknown>): "bug" | "feedback" {
  const raw = row.type ?? row.report_type ?? row.reportType;
  return raw === "feedback" ? "feedback" : "bug";
}

function reporterRole(row: Record<string, unknown>, fallback: string): string {
  const raw = String(row.reporterRole ?? row.reporter_role ?? fallback).toLowerCase();
  if (raw === "resident" || raw === "manager" || raw === "admin" || raw === "pro" || raw === "vendor") return raw;
  return fallback;
}

const route = createJsonRecordRoute({
  table: "portal_bug_feedback_records",
  select: "id, reporter_user_id, reporter_email, reporter_role, report_type, row_data, created_at, updated_at",
  scope: (query, user) => {
    if (user.role === "admin") return query;
    const scoped = query as {
      eq: (col: string, val: string) => unknown;
      or: (filters: string) => unknown;
    };
    const email = user.email?.trim().toLowerCase();
    if (email) {
      const scope = orFilterForIdentity([
        ["reporter_user_id", user.id],
        ["reporter_email", email],
      ]);
      if (scope) return scoped.or(scope);
    }
    return scoped.eq("reporter_user_id", user.id);
  },
  normalize: (row) => ({
    ...row,
    id: String(row.id ?? "").trim(),
    reporterUserId: String(row.reporterUserId ?? row.reporter_user_id ?? "").trim(),
    reporterName: String(row.reporterName ?? row.reporter_name ?? "").trim(),
    reporterEmail: String(row.reporterEmail ?? row.reporter_email ?? "").trim().toLowerCase(),
    reporterRole: reporterRole(row, "manager"),
    type: feedbackType(row),
    title: String(row.title ?? "").trim(),
    description: String(row.description ?? "").trim(),
    createdAt: String(row.createdAt ?? row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updatedAt ?? row.updated_at ?? new Date().toISOString()),
  }),
  buildUpsert: (row, user) => {
    const isAdmin = user.role === "admin";
    const reporterUserId = isAdmin
      ? String(row.reporterUserId ?? row.reporter_user_id ?? user.id)
      : user.id;
    const reporterEmail = String(row.reporterEmail ?? row.reporter_email ?? user.email ?? "")
      .trim()
      .toLowerCase();
    const role = reporterRole(row, user.role);
    const type = feedbackType(row);
    const storedRow = {
      ...row,
      id: String(row.id ?? "").trim(),
      reporterUserId,
      reporterEmail,
      reporterRole: role,
      type,
    };
    return {
      id: storedRow.id,
      reporter_user_id: reporterUserId,
      reporter_email: reporterEmail,
      reporter_role: role,
      report_type: type,
      row_data: storedRow,
      updated_at: new Date().toISOString(),
    };
  },
});

export const GET = route.GET;
export const POST = route.POST;
