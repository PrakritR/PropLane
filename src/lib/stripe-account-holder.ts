import type Stripe from "stripe";

/** The verified legal name on a connected account: the individual's name, else the company's. Null until Stripe has one. */
export function accountHolderNameFromAccount(account: Pick<Stripe.Account, "individual" | "company" | "business_profile">): string | null {
  const person = [account.individual?.first_name, account.individual?.last_name].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  if (person) return person;
  return account.company?.name?.trim() || null;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
}

/** Order- and punctuation-insensitive: "Rao, Ambika" matches "Ambika Rao". */
export function holderNamesMatch(a: string, b: string): boolean {
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}
