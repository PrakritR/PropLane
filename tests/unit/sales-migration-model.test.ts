import { prepareSalesFinancialBlock } from "@/lib/sales-migration/financial-source";
import { depositDispositionAmounts } from "@/lib/reports/deposit-disposition-amounts";
import type { SecurityDepositLedgerRow } from "@/lib/reports/security-deposits";
import { describe, expect, it } from "vitest";
import { validateMigration, type SalesMigration } from "@/lib/sales-migration/model";
import { allocateUtilityBill } from "@/lib/utility-allocation";
import { parseStatementCsv, statementMatchSuggestions, statementMatchReview } from "@/lib/statement-file-intake";
const source = { sheet: "Roster", range: "A4:Z4", recordKey: "payment1" };
export const validPlan = (): SalesMigration => ({ version: 2, workbookId: "fixture", asOf: "2026-09-05", inventory: [{ propertyKey: "p", roomCount: 1 }], unresolved: [], properties: [{ propertyKey: "p", propertyId: "canonical-p", sheet: "Roster", rooms: [{ roomId: "r", roomNumber: 1 }], tenancies: [{ source, tenancyKey: "stay1", roomId: "r", name: "Resident", email: "resident@example.test", start: "2026-01-01", end: null, monthToMonth: true, monthlyRentCents: 100000 }], facts: [], checks: [] }] });
describe("canonical migration validation", () => {
  it("requires physical inventory independent of the roster", () => { const p=validPlan(); p.inventory[0]!.roomCount=2; expect(()=>validateMigration(p)).toThrow(/room count/); });
  it("does not accept a legacy arbitrary-action executor plan", () => expect(()=>validateMigration({actions:[]})).toThrow());
  it("blocks an unspecified end date and false month-to-month", () => { const p=validPlan(); p.properties[0]!.tenancies[0]!.monthToMonth=false; expect(()=>validateMigration(p)).toThrow(/Confirm/); });
  it("rejects impossible dates", () => { const p=validPlan(); p.asOf="2026-02-30"; expect(()=>validateMigration(p)).toThrow(); });
  it("rejects duplicate source identities and distinct tenancy key collisions", () => { const p=validPlan(); p.properties[0]!.tenancies.push(p.properties[0]!.tenancies[0]!); expect(()=>validateMigration(p)).toThrow(/Duplicate tenancy/); });
  it("requires balances to refer to an identified tenancy", () => { const p=validPlan(); p.properties[0]!.facts=[{ source, kind:"opening_balance",chargeKind:"rent",date:"2026-09-01",amountCents:1000,categoryCode:"rent_income",description:"Unpaid rent",tenancyKey:"other" }]; expect(()=>validateMigration(p)).toThrow(/resolved tenancy/); });
  it("keeps refunds and deductions distinct and refuses over-disposition", () => { const p=validPlan(); const base={source,tenancyKey:"stay1",date:"2026-09-01",amountCents:60000,categoryCode:"security_deposit_liability",description:"Deposit"}; p.properties[0]!.facts=[{...base,kind:"deposit_held"},{...base,source:{...source,recordKey:"refund"},kind:"deposit_refund",depositRecordKey:source.recordKey,amountCents:50000},{...base,source:{...source,recordKey:"deduct"},kind:"deposit_deduction",depositRecordKey:source.recordKey,amountCents:20000}]; expect(()=>validateMigration(p)).toThrow(/exceed/); p.properties[0]!.facts[2]!.amountCents=10000; expect(validateMigration(p)).toEqual(p); });
  it("treats summaries as checks, never extra income", () => { const p=validPlan(); p.properties[0]!.facts=[{source,kind:"income",date:"2026-09-01",amountCents:5000,categoryCode:"rent_income",description:"Income"}]; p.properties[0]!.checks=[{source,kind:"income",start:"2026-09-01",end:"2026-09-05",expectedCents:10000}]; expect(()=>validateMigration(p)).toThrow(/does not reconcile/); });
});
describe("actual utilities allocation", () => {
  const placements=[{id:"a",roomId:"r1",start:"2026-09-01",end:null},{id:"b",roomId:"r1",start:"2026-09-01",end:null},{id:"c",roomId:"r2",start:"2026-09-01",end:null}];
  it("allocates resident-days with every cent retained", () => { const rows=allocateUtilityBill({amountCents:100,start:"2026-09-01",end:"2026-09-30",rule:"occupant_days",placements}); expect(rows.map(r=>r.amountCents)).toEqual([34,33,33]); });
  it("splits shared room-days between roommates", () => { const rows=allocateUtilityBill({amountCents:100,start:"2026-09-01",end:"2026-09-30",rule:"occupied_room_days",placements}); expect(rows.map(r=>r.amountCents)).toEqual([25,25,50]); });
  it("honors inclusive move-in/out and exclusions", () => { const rows=allocateUtilityBill({amountCents:300,start:"2026-09-01",end:"2026-09-30",rule:"occupant_days",placements:[{...placements[0]!,end:"2026-09-15"},placements[1]!,placements[2]!],excludeIds:["c"]}); expect(rows.map(r=>r.amountCents)).toEqual([100,200]); });
  it("rejects duplicate placements and unoccupied periods", () => { expect(()=>allocateUtilityBill({amountCents:100,start:"2026-09-01",end:"2026-09-30",rule:"occupant_days",placements:[placements[0]!,placements[0]!]})).toThrow(/Duplicate/); expect(()=>allocateUtilityBill({amountCents:100,start:"2025-09-01",end:"2025-09-30",rule:"occupant_days",placements})).toThrow(/No eligible/); });
});
describe("statement file intake", () => {
  it("reads quoted descriptions, exact cents and negative amounts", () => expect(parseStatementCsv('Date,Description,Amount\r\n9/1/2026,"Repair, materials",-12.35\r\n2026-09-02,Rent,100.00')).toEqual([{lineDate:"2026-09-01",description:"Repair, materials",amountCents:-1235},{lineDate:"2026-09-02",description:"Rent",amountCents:10000}]));
  it("reads separate debit and credit columns without netting ambiguous rows", () => { expect(parseStatementCsv('Date,Description,Debit,Credit\n9/1/2026,Repair,12.35,')[0]?.amountCents).toBe(-1235); expect(()=>parseStatementCsv('Date,Description,Debit,Credit\n9/1/2026,Repair,12,2')).toThrow(/one positive/); });
  it("rejects malformed, fractional-cent and impossible-date input", () => { for(const csv of ['Date,Description,Amount\n2026-02-30,Rent,10','Date,Description,Amount\n2026-09-01,Rent,1.001','Date,Description,Amount\n2026-09-01,"Unclosed,10']) expect(()=>parseStatementCsv(csv)).toThrow(); });
  it("suggests multiple matches without choosing or clearing one", () => { const candidates=[{id:"a",kind:"income" as const,date:"2026-09-01",amountCents:10000},{id:"b",kind:"income" as const,date:"2026-09-02",amountCents:10000},{id:"c",kind:"expense" as const,date:"2026-09-01",amountCents:10000}]; expect(statementMatchSuggestions({lineDate:"2026-09-01",amountCents:10000},candidates).map(c=>c.id)).toEqual(["a","b"]); });
});

describe("deposit packet amounts", () => {
  const base = { amountCents: 60000, amountHeldCents: 0, dispositionType: "full_refund", dispositionJournalId: "current" };
  it("retains earlier deductions when the last disposition refunds the remainder", () => {
    const d = { ...base, itemization: [{kind:"deduction",amountCents:10000,label:"Repair",sourceId:"history"},{kind:"refund",amountCents:50000,label:"Refund",journalId:"current"}] } as SecurityDepositLedgerRow;
    expect(depositDispositionAmounts(d)).toMatchObject({withheldCents:10000,refundCents:50000,priorRefundCents:0});
  });
  it("does not add remaining held funds to a partial refund", () => {
    const d = {...base,amountHeldCents:30000,itemization:[{kind:"refund",amountCents:10000,label:"Prior",sourceId:"history"},{kind:"refund",amountCents:20000,label:"Current",journalId:"current"}]} as SecurityDepositLedgerRow;
    expect(depositDispositionAmounts(d)).toMatchObject({refundCents:20000,priorRefundCents:10000,remainingHeldCents:30000});
  });
});

describe("explicit financial block mapping", () => {
  const mapping = { propertyKey: "p", sheet: "P&L", firstRow: 20, columns: { date: 0, description: 1, amount: 2, recordKey: 3 }, kind: "expense" as const, categoryCode: "maintenance", amountSign: "negative" as const };
  it("maps only dated transactions with exact cents and explicit sign", () => {
    const result = prepareSalesFinancialBlock({...mapping,rows:[["9/1/2026","Repair","-12.35","invoice-1"],["September","Total","-12.35","total"],["9/2/2026","Partial note","350 for rent","note"]]});
    expect(result.facts).toHaveLength(1);expect(result.facts[0]).toMatchObject({date:"2026-09-01",amountCents:1235,source:{range:"20:20",recordKey:"invoice-1"}});expect(result.unresolved).toHaveLength(2);
  });
  it("withholds both rows when their transaction key is ambiguous", () => {
    const result = prepareSalesFinancialBlock({...mapping,rows:[["9/1/2026","Repair","-12.35","duplicate"],["9/2/2026","Another repair","-20","duplicate"]]});
    expect(result.facts).toEqual([]);expect(result.unresolved[0]?.reason).toMatch(/Duplicate/);
  });
});


describe("financial source and bank review ambiguity", () => {
  it("withholds every duplicate key even when the first row is invalid", () => {
    const result = prepareSalesFinancialBlock({ propertyKey: "p", sheet: "Accounts", firstRow: 1,
      columns: { date: 0, description: 1, amount: 2, recordKey: 3 }, kind: "income", categoryCode: "rent_income", amountSign: "positive",
      rows: [["unknown", "Earlier row", "100", "same"], ["9/1/2026", "Later row", "100", "same"]],
    });
    expect(result.facts).toEqual([]);
    expect(result.unresolved.map(issue => [issue.source.range, issue.reason])).toEqual([
      ["1:1", "Duplicate stable transaction key"], ["2:2", "Duplicate stable transaction key"],
    ]);
  });
  it("marks a sole receipt ambiguous when two bank lines compete for it", () => {
    const reviews = statementMatchReview([
      {id:"line-a",lineDate:"2026-09-01",amountCents:10000},
      {id:"line-b",lineDate:"2026-09-02",amountCents:10000},
      {id:"line-c",lineDate:"2026-09-01",amountCents:-10000},
    ], [{id:"receipt",kind:"income",date:"2026-09-01",amountCents:10000}, {id:"expense",kind:"expense",date:"2026-09-01",amountCents:10000}]);
    expect(reviews.map(r => [r.lineId, r.ambiguous, r.competingLineIds])).toEqual([
      ["line-a", true, ["line-b"]], ["line-b", true, ["line-a"]], ["line-c", false, []],
    ]);
    expect(reviews.every(r => r.candidates.length === 1)).toBe(true);
  });
});
