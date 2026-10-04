import type { ManagerPayee, ManagerTeammate } from "@/lib/manager-payees";

export type PayeeBook = { payees: ManagerPayee[]; teammates: ManagerTeammate[] };

/** Saved payees plus the manager's team (the only people a teammate payment can name). */
export async function fetchPayeeBook(): Promise<PayeeBook> {
  const res = await fetch("/api/manager/payees", { credentials: "include", cache: "no-store" });
  const data = (await res.json()) as Partial<PayeeBook> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load payees.");
  return { payees: data.payees ?? [], teammates: data.teammates ?? [] };
}

export async function savePayee(body: Record<string, unknown>): Promise<ManagerPayee> {
  const res = await fetch("/api/manager/payees", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { payee?: ManagerPayee; error?: string };
  if (!res.ok || !data.payee) throw new Error(data.error ?? "Could not save payee.");
  return data.payee;
}

export async function updatePayeeDetails(id: string, body: Record<string, unknown>): Promise<ManagerPayee> {
  const res = await fetch("/api/manager/payees", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, id }),
  });
  const data = (await res.json()) as { payee?: ManagerPayee; error?: string };
  if (!res.ok || !data.payee) throw new Error(data.error ?? "Could not update payee.");
  return data.payee;
}
