import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import {
  buildPortfolioImportDraft,
  recomputeDraftAfterEdits,
} from "@/lib/portfolio-import/build-draft";
import { applyManualColumnMapping } from "@/lib/portfolio-import/column-map";
import { loadManagerExistingResidentEmails } from "@/lib/portfolio-import/parse.server";
import { portfolioImportMessagingStatus } from "@/lib/portfolio-import/invite.server";
import {
  discardPortfolioImport,
  loadPortfolioImport,
  summaryFor,
  updatePortfolioImportDraft,
} from "@/lib/portfolio-import/store.server";
import type {
  PortfolioImportBalance,
  PortfolioImportCanonicalKey,
  PortfolioImportDraft,
  PortfolioImportIssue,
  PortfolioImportProperty,
  PortfolioImportResident,
  PortfolioImportUnit,
} from "@/lib/portfolio-import/types";

export const runtime = "nodejs";

type PatchBody = {
  columns?: Array<{ index: number; key: PortfolioImportCanonicalKey | null }>;
  residents?: Array<
    { key: string } & Partial<
      Pick<
        PortfolioImportResident,
        "name" | "email" | "phone" | "leaseStart" | "leaseEnd" | "monthlyRent" | "securityDeposit" | "excluded" | "leasePdf"
      >
    >
  >;
  units?: Array<{ key: string } & Partial<Pick<PortfolioImportUnit, "label" | "monthlyRent" | "securityDeposit" | "excluded">>>;
  properties?: Array<{ key: string } & Partial<Pick<PortfolioImportProperty, "name" | "address" | "zip" | "excluded">>>;
  balances?: Array<{ key: string; create: boolean }>;
  issues?: Array<{ id: string; resolved: boolean }>;
};

async function requireOwnedImport(importId: string) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return { error: NextResponse.json({ error: "Sign in required." }, { status: 401 }) } as const;
  if (auth.role !== "manager" && auth.role !== "admin") {
    return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) } as const;
  }
  const row = await loadPortfolioImport(auth.db, auth.userId, importId);
  if (!row) return { error: NextResponse.json({ error: "Import not found." }, { status: 404 }) } as const;
  return { auth, row } as const;
}

export async function GET(_req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const found = await requireOwnedImport(importId);
  if ("error" in found) return found.error;
  const { auth, row } = found;

  const messaging = await portfolioImportMessagingStatus(auth.db, auth.userId).catch(() => ({
    workNumber: null,
    canText: false,
    settingsHref: "/portal/profile?tab=messaging",
  }));

  return NextResponse.json({
    importId: row.id,
    status: row.status,
    summary: summaryFor(row),
    draft: row.draft?.draft ?? null,
    result: row.result ?? null,
    messaging,
  });
}

function applyPropertyEdits(properties: PortfolioImportProperty[], patches: PatchBody["properties"]): PortfolioImportProperty[] {
  if (!patches?.length) return properties;
  const byKey = new Map(patches.map((p) => [p.key, p]));
  return properties.map((property) => {
    const patch = byKey.get(property.key);
    if (!patch) return property;
    return {
      ...property,
      name: typeof patch.name === "string" ? patch.name : property.name,
      address: typeof patch.address === "string" ? patch.address : property.address,
      zip: typeof patch.zip === "string" ? patch.zip : property.zip,
      excluded: typeof patch.excluded === "boolean" ? patch.excluded : property.excluded,
    };
  });
}

function applyUnitEdits(units: PortfolioImportUnit[], patches: PatchBody["units"]): PortfolioImportUnit[] {
  if (!patches?.length) return units;
  const byKey = new Map(patches.map((u) => [u.key, u]));
  return units.map((unit) => {
    const patch = byKey.get(unit.key);
    if (!patch) return unit;
    return {
      ...unit,
      label: typeof patch.label === "string" ? patch.label : unit.label,
      monthlyRent: typeof patch.monthlyRent === "number" ? patch.monthlyRent : unit.monthlyRent,
      securityDeposit: typeof patch.securityDeposit === "number" ? patch.securityDeposit : unit.securityDeposit,
      excluded: typeof patch.excluded === "boolean" ? patch.excluded : unit.excluded,
    };
  });
}

function applyResidentEdits(residents: PortfolioImportResident[], patches: PatchBody["residents"]): PortfolioImportResident[] {
  if (!patches?.length) return residents;
  const byKey = new Map(patches.map((r) => [r.key, r]));
  return residents.map((resident) => {
    const patch = byKey.get(resident.key);
    if (!patch) return resident;
    return {
      ...resident,
      name: typeof patch.name === "string" ? patch.name : resident.name,
      email: patch.email !== undefined ? patch.email : resident.email,
      phone: patch.phone !== undefined ? patch.phone : resident.phone,
      leaseStart: patch.leaseStart !== undefined ? patch.leaseStart : resident.leaseStart,
      leaseEnd: patch.leaseEnd !== undefined ? patch.leaseEnd : resident.leaseEnd,
      monthlyRent: patch.monthlyRent !== undefined ? patch.monthlyRent : resident.monthlyRent,
      securityDeposit: patch.securityDeposit !== undefined ? patch.securityDeposit : resident.securityDeposit,
      excluded: typeof patch.excluded === "boolean" ? patch.excluded : resident.excluded,
      leasePdf: patch.leasePdf !== undefined ? patch.leasePdf : resident.leasePdf,
    };
  });
}

function applyBalanceEdits(balances: PortfolioImportBalance[], patches: PatchBody["balances"]): PortfolioImportBalance[] {
  if (!patches?.length) return balances;
  const byKey = new Map(patches.map((b) => [b.key, b]));
  return balances.map((balance) => {
    const patch = byKey.get(balance.key);
    if (!patch) return balance;
    return { ...balance, create: typeof patch.create === "boolean" ? patch.create : balance.create };
  });
}

function applyIssueEdits(issues: PortfolioImportIssue[], patches: PatchBody["issues"]): PortfolioImportIssue[] {
  if (!patches?.length) return issues;
  const byId = new Map(patches.map((i) => [i.id, i]));
  return issues.map((issue) => {
    const patch = byId.get(issue.id);
    if (!patch) return issue;
    return { ...issue, resolved: typeof patch.resolved === "boolean" ? patch.resolved : issue.resolved };
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const found = await requireOwnedImport(importId);
  if ("error" in found) return found.error;
  const { auth, row } = found;

  const limited = await rateLimit(`portfolio-import-edit:${auth.userId}`, 30, 60_000);
  if (!limited.ok) return NextResponse.json({ error: "Too many edit requests. Try again shortly." }, { status: 429 });

  if (row.status !== "draft" && row.status !== "uploaded") {
    return NextResponse.json({ error: "This import can no longer be edited." }, { status: 409 });
  }
  if (!row.draft) return NextResponse.json({ error: "Import has no draft to edit." }, { status: 409 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  let nextDraft: PortfolioImportDraft;
  if (Array.isArray(body.columns) && body.columns.length > 0) {
    let columns = row.draft.draft.columns;
    for (const change of body.columns) {
      if (typeof change.index !== "number") continue;
      columns = applyManualColumnMapping(columns, change.index, change.key ?? null);
    }
    const existingEmails = await loadManagerExistingResidentEmails(auth.db, auth.userId);
    nextDraft = buildPortfolioImportDraft({
      table: row.draft.table,
      columns,
      sourceKind: row.draft.draft.sourceKind,
      preset: row.draft.draft.preset,
      fileName: row.draft.draft.fileName,
      existingEmails,
    });
  } else {
    let draft = row.draft.draft;
    draft = { ...draft, properties: applyPropertyEdits(draft.properties, body.properties) };
    draft = { ...draft, units: applyUnitEdits(draft.units, body.units) };
    draft = { ...draft, residents: applyResidentEdits(draft.residents, body.residents) };
    draft = { ...draft, balances: applyBalanceEdits(draft.balances, body.balances) };
    draft = { ...draft, issues: applyIssueEdits(draft.issues, body.issues) };
    nextDraft = recomputeDraftAfterEdits(draft);
  }

  const updated = await updatePortfolioImportDraft(auth.db, auth.userId, importId, {
    table: row.draft.table,
    draft: nextDraft,
  });

  const messaging = await portfolioImportMessagingStatus(auth.db, auth.userId).catch(() => ({
    workNumber: null,
    canText: false,
    settingsHref: "/portal/profile?tab=messaging",
  }));

  return NextResponse.json({
    importId: updated.id,
    status: updated.status,
    summary: summaryFor(updated),
    draft: updated.draft?.draft ?? null,
    result: updated.result ?? null,
    messaging,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const found = await requireOwnedImport(importId);
  if ("error" in found) return found.error;
  const { auth, row } = found;

  if (row.status === "completed") {
    return NextResponse.json({ error: "A completed import can't be discarded." }, { status: 409 });
  }

  await discardPortfolioImport(auth.db, auth.userId, importId);
  return NextResponse.json({ ok: true });
}
