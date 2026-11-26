/**
 * find_security_deposit: "the deposit for the resident who just moved out of 4709a Room 2". The deposit ledger is keyed
 * by a deposit id and a resident email, never by a room, so this goes through the one resident resolver
 * (`resident-lookup.ts`) and then reads the ledger rows held for those residents. Read-only: the return itself is
 * `dispose_security_deposit` (preview + YES), which takes the id this returns.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import { listSecurityDeposits, type SecurityDepositLedgerRow } from "@/lib/reports/security-deposits";
import { resolveManagerResidents } from "./resident-lookup";

const money = (cents: number): string => `$${(Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function depositForReply(d: SecurityDepositLedgerRow, who: { name: string; house: string; room: string; movedOut: boolean }) {
  return {
    depositId: d.id,
    resident: who.name,
    house: who.house,
    room: who.room || null,
    movedOut: who.movedOut,
    status: d.status,
    received: d.receivedDate,
    originalAmount: money(d.amountCents),
    amountHeld: money(d.amountHeldCents),
    amountHeldCents: d.amountHeldCents,
  };
}

export const findSecurityDepositTool = defineTool({
  name: "find_security_deposit",
  description:
    'Find the security deposit held for a resident by name, email, or "<house> Room <N>" (e.g. "4709a Room 2"), including a resident who has already moved out. Returns the deposit id, status and the amount still held (computed by the tool). Use it BEFORE dispose_security_deposit to get the depositId; never guess an id. When several residents or deposits fit, the reply lists them: ask one question.',
  kind: "read",
  inputSchema: z
    .object({
      resident: z.string().min(2).max(120).describe('A name, an email, or "<house> Room <N>".'),
      status: z.enum(["held", "any"]).optional().describe("Default held: only deposits still waiting to be returned."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const { matches, question } = await resolveManagerResidents(ctx, input.resident, { includeMovedOut: true });
    if (matches.length === 0) return { count: 0, deposits: [], message: question };
    const workspacePropertyIds = ctx.workspace?.narrowing ? [...ctx.workspace.propertyIds] : null;
    const rows = await listSecurityDeposits(ctx.db, ctx.landlordId, { workspacePropertyIds });
    const wantHeld = (input.status ?? "held") === "held";
    const deposits = matches.flatMap((m) =>
      rows
        .filter((d) => d.residentEmail.trim().toLowerCase() === m.email && (!wantHeld || d.status === "held" || d.status === "partially_refunded") && d.amountHeldCents > 0)
        .map((d) => depositForReply(d, { name: m.name || m.email, house: m.houseTitle, room: m.roomLabel, movedOut: m.movedOut })),
    );
    // A moved-out resident is the answer to "who just moved out"; the current one in that room is named only to be told apart.
    deposits.sort((a, b) => Number(b.movedOut) - Number(a.movedOut));
    return {
      count: deposits.length,
      deposits,
      message:
        deposits.length === 0
          ? `No held deposit found for ${matches.map((m) => m.name || m.email).join(", ")}.`
          : deposits.length > 1
            ? "More than one deposit fits. Ask which resident, then pass that depositId to dispose_security_deposit."
            : null,
    };
  },
});
