import { createJsonRecordRoute } from "@/lib/portal-record-api";

export const runtime = "nodejs";

const route = createJsonRecordRoute({
  table: "portal_outbound_mail_records",
  select: "id, row_data, created_at",
  orderColumn: "created_at",
  scope: (query, user) => {
    const q = query as { eq: (column: string, value: string) => unknown };
    if (user.role === "admin") return query;
    return q.eq("recipient_email", user.email ?? "");
  },
  buildUpsert: (row) => ({
    id: row.id,
    recipient_email: row.to ?? row.recipientEmail ?? row.recipient_email ?? null,
    subject: row.subject ?? null,
    row_data: row,
  }),
});

export async function GET(req: Request) {
  return route.GET(req);
}
export const POST = route.POST;
