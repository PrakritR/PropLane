import { NextResponse } from "next/server";
import { assertManagerFinancialsCoManagerAccess } from "@/lib/auth/co-manager-access";
import {
  fetchRowsForManagerWithLinked,
  linkedPropertyIdsForModule,
  type ManagerWorkspaceRowScope,
} from "@/lib/auth/co-manager-module-scope";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { mapManagerBillRow, MANAGER_BILL_SELECT } from "@/lib/manager-bills";
import { createManagerBill } from "@/lib/manager-bills.server";
import { resolvePropertyPayoutOwner } from "@/lib/payments/property-payout-owner.server";
import { track } from "@/lib/analytics/posthog";
import { applyWorkspaceRowScope, resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const status = new URL(req.url).searchParams.get("status")?.trim();
    // The list follows the same active-workspace rule the bill writes already
    // use (`manager-bills.server.ts`): a bill tied to a house outside the
    // active workspace is another workspace's payable, and an account-level
    // bill (no property) belongs to the viewer's own default workspace.
    const wsScope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    let query = applyWorkspaceRowScope(
      auth.db
        .from("manager_bills")
        .select(MANAGER_BILL_SELECT)
        .eq("manager_user_id", auth.userId)
        .order("created_at", { ascending: false })
        .limit(200),
      wsScope,
    );
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    let bills = (data ?? []).map((r) => mapManagerBillRow(r as Record<string, unknown>));

    // Co-managers granted "financials" on a linked owner's property also see
    // that owner's bills for it — merged the same way household charges
    // merges a co-manager's linked rows, narrowed to the active workspace so
    // a granted house is reachable only in the workspace that holds it.
    if (auth.role === "manager") {
      const managerWsScope: ManagerWorkspaceRowScope = {
        propertyIds: wsScope.propertyIds,
        untaggedOwnedVisible: wsScope.includeUntagged,
      };
      const linkedPropertyIds = await linkedPropertyIdsForModule(auth.db, auth.userId, "financials");
      if (linkedPropertyIds.size > 0) {
        const linkedRows = await fetchRowsForManagerWithLinked<{ id: string; [key: string]: unknown }>(
          auth.db,
          "manager_bills",
          auth.userId,
          linkedPropertyIds,
          { select: MANAGER_BILL_SELECT, propertyColumns: ["property_id"], workspaceScope: managerWsScope },
        );
        const seen = new Set(bills.map((b) => b.id));
        for (const row of linkedRows) {
          const mapped = mapManagerBillRow(row);
          if (!seen.has(mapped.id)) {
            bills.push(mapped);
            seen.add(mapped.id);
          }
        }
        if (status) bills = bills.filter((b) => b.status === status);
      }
    }

    return NextResponse.json({ bills });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list bills.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      description?: string;
      amountCents?: number;
      dueDate?: string;
      vendorId?: string;
      workOrderId?: string;
      propertyId?: string;
      categoryCode?: string;
    };
    const propertyId = body.propertyId?.trim() || null;

    // A bill must land on the PROPERTY'S owner, never the caller — the same
    // bug class PRP-199 closed for household charges. Every check below keyed
    // off the property the caller named, so a co-manager with a financials
    // grant could already file a bill; without this it was stamped under the
    // co-manager's own id, so the real owner never saw it (see manager_bills
    // GET's owned+linked merge above) while it polluted the co-manager's own
    // Bills view with someone else's payable.
    let managerUserId = auth.userId;
    if (propertyId) {
      const owner = await resolvePropertyPayoutOwner(auth.db, propertyId);
      if (!owner.ok && owner.reason === "lookup_failed") {
        // A property that cannot be read is not an unowned property. Refuse
        // rather than guess a payee — the same rule the payout context uses.
        return NextResponse.json(
          { error: "Could not verify the property for this bill. Try again in a moment." },
          { status: 503 },
        );
      }
      if (owner.ok && owner.ownerUserId) managerUserId = owner.ownerUserId;
    }

    // Creating/updating bills is a write — requires the "edit" level on financials.
    // ownerManagerUserId is the property's real owner (resolved above), never
    // the caller: passing the caller would short-circuit the check
    // (owner===caller => allow) and make the gate a no-op when the caller is
    // NOT that owner. Passing the real owner pairs the property scope with
    // the grant that actually issued it.
    const cm = await assertManagerFinancialsCoManagerAccess(
      auth.db,
      auth.userId,
      propertyId,
      managerUserId !== auth.userId ? managerUserId : undefined,
      "edit",
    );
    if (!cm.ok) return NextResponse.json({ error: cm.error }, { status: cm.status });

    const bill = await createManagerBill(auth.db, {
      managerUserId,
      // The active workspace that gates this write is the ACTOR's (the
      // signed-in browser session), not the resolved owner's — a co-manager
      // acting inside their own active workspace selection, same as the
      // household-charges create path.
      viewerUserId: auth.userId,
      description: body.description?.trim() || "Bill",
      amountCents: Math.round(Number(body.amountCents) || 0),
      dueDate: body.dueDate,
      vendorId: body.vendorId,
      workOrderId: body.workOrderId,
      propertyId: propertyId ?? undefined,
      categoryCode: body.categoryCode,
    });

    track("bill_created", auth.userId, { billId: bill.id, amountCents: bill.amountCents });
    return NextResponse.json({ bill });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create bill.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
