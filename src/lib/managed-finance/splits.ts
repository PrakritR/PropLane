/**
 * Payout splits (Airbnb co-host style) on a PropLane-managed workspace. Pure: rules and one payment's owner share go in, whole-cent
 * shares come out. Nothing here reads a database or moves money.
 *
 * What a rule is paid FROM: the OWNER's share of a settled payment (after PropLane's management fee), never the gross and never
 * PropLane's fee. A percent rule takes `floor(ownerCents * bps / 10000)`; a fixed rule takes its amount per payment, capped at what
 * is left. The owner keeps the remainder, so the shares always sum to the owner's share exactly.
 */

/** Charge kinds a split rule may name. `cleaning_fee` is accepted for a future cleaning charge; today a stay's cleaning rides in `stay_total`. */
export const SPLITTABLE_KINDS = [
  "rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent", "stay_total", "cleaning_fee", "move_in_fee",
] as const;
export type SplittableKind = (typeof SPLITTABLE_KINDS)[number];

export const DEFAULT_SPLIT_KINDS: readonly SplittableKind[] = ["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent", "stay_total"];

export const MAX_FIXED_SPLIT_CENTS = 100_000_000;

export type SplitRule = {
  id: string;
  workspaceId: string;
  /** null = the whole workspace; set = an override for that house (it replaces the workspace rules for that house). */
  propertyId: string | null;
  ruleKind: "percent" | "fixed";
  appliesTo: readonly string[];
  payeeKind: "member" | "vendor";
  payeeUserId: string;
  bps: number | null;
  fixedCents: number | null;
  effectiveFrom: string;
  endedAt: string | null;
  createdAt?: string;
};

export type SplitPayment = {
  chargeKind: string;
  propertyId: string | null;
  /** The owner's share of this charge in cents (what the owner would receive with no split). */
  ownerCents: number;
  /** When the resident paid. Rules are read AS OF this moment, never "now". */
  paidAt: string;
};

export type SplitShare = {
  ruleId: string;
  payeeKind: "member" | "vendor";
  payeeUserId: string;
  cents: number;
};

export type SplitResult = {
  shares: SplitShare[];
  /** What the owner keeps: ownerCents minus every share. Always >= 0. */
  ownerRemainderCents: number;
};

/** Was this rule in force at `at`? `effective_from <= at < ended_at`. */
export function ruleActiveAt(rule: Pick<SplitRule, "effectiveFrom" | "endedAt">, at: string): boolean {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (Date.parse(rule.effectiveFrom) > t) return false;
  return rule.endedAt === null || t < Date.parse(rule.endedAt);
}

/**
 * The rules that apply to one payment: active at the payment date, naming the charge kind, and for the house: when ANY rule is
 * scoped to this house the house's rules REPLACE the workspace-wide ones (an override), otherwise the workspace-wide rules apply.
 */
export function rulesForPayment(rules: readonly SplitRule[], payment: Pick<SplitPayment, "chargeKind" | "propertyId" | "paidAt">): SplitRule[] {
  const live = rules.filter((r) => ruleActiveAt(r, payment.paidAt) && r.appliesTo.includes(payment.chargeKind));
  const house = payment.propertyId ? live.filter((r) => r.propertyId === payment.propertyId) : [];
  const chosen = house.length > 0 ? house : live.filter((r) => r.propertyId === null);
  // A stable order: oldest rule first, ties by id, so the same inputs always produce the same shares.
  return [...chosen].sort((a, b) => (a.createdAt ?? a.effectiveFrom).localeCompare(b.createdAt ?? b.effectiveFrom) || a.id.localeCompare(b.id));
}

/**
 * Compute the shares of one payment. Integer cents; percent rules are computed on the owner's share and floor; fixed rules come
 * after them and are capped at the remainder, so `sum(shares) + ownerRemainder === ownerCents` always.
 */
export function computeSplit(rules: readonly SplitRule[], payment: SplitPayment): SplitResult {
  if (!Number.isSafeInteger(payment.ownerCents) || payment.ownerCents < 0) throw new Error("A split needs a whole-cent owner share.");
  const applicable = rulesForPayment(rules, payment);
  let remaining = payment.ownerCents;
  const shares: SplitShare[] = [];
  const base = payment.ownerCents;
  for (const rule of applicable.filter((r) => r.ruleKind === "percent")) {
    const bps = rule.bps ?? 0;
    const cents = Math.min(Math.floor((base * bps) / 10_000), remaining);
    if (cents <= 0) continue;
    shares.push({ ruleId: rule.id, payeeKind: rule.payeeKind, payeeUserId: rule.payeeUserId, cents });
    remaining -= cents;
  }
  for (const rule of applicable.filter((r) => r.ruleKind === "fixed")) {
    const cents = Math.min(rule.fixedCents ?? 0, remaining);
    if (cents <= 0) continue;
    shares.push({ ruleId: rule.id, payeeKind: rule.payeeKind, payeeUserId: rule.payeeUserId, cents });
    remaining -= cents;
  }
  return { shares, ownerRemainderCents: remaining };
}

export type SplitRuleDraft = {
  propertyId: string | null;
  ruleKind: "percent" | "fixed";
  appliesTo: readonly string[];
  payeeKind: "member" | "vendor";
  payeeUserId: string;
  bps: number | null;
  fixedCents: number | null;
};

export type SplitValidationContext = {
  /** The workspace's current rules (the draft is checked against the ACTIVE ones, as of `now`). */
  activeRules: readonly SplitRule[];
  /** The owner of record: never a payee of their own split. */
  ownerUserId: string | null;
  /** Payee eligibility, re-derived by the server: a workspace member, or a vendor with a connected account. */
  payeeIsWorkspaceMember: boolean;
  payeeIsVendorWithConnectedAccount: boolean;
  /** The house id is one of the workspace's houses (re-derived by the server), or null. */
  propertyInWorkspace: boolean;
};

/** Validate a new rule. Returns a person-readable error, or null when the rule may be added. */
export function validateSplitRule(draft: SplitRuleDraft, ctx: SplitValidationContext): string | null {
  if (!draft.payeeUserId) return "Choose who is paid.";
  if (ctx.ownerUserId && draft.payeeUserId === ctx.ownerUserId) return "The owner already keeps the remainder; choose someone else.";
  if (draft.ruleKind === "percent") {
    if (!Number.isSafeInteger(draft.bps) || (draft.bps ?? 0) <= 0 || (draft.bps ?? 0) > 10_000) return "Enter a percent between 0.01 and 100.";
    if (draft.fixedCents !== null) return "A percent rule has no fixed amount.";
  } else if (draft.ruleKind === "fixed") {
    if (!Number.isSafeInteger(draft.fixedCents) || (draft.fixedCents ?? 0) <= 0 || (draft.fixedCents ?? 0) > MAX_FIXED_SPLIT_CENTS) return "Enter a dollar amount above zero.";
    if (draft.bps !== null) return "A fixed rule has no percent.";
  } else {
    return "Choose percent or fixed.";
  }
  if (draft.appliesTo.length === 0) return "Choose what the rule applies to.";
  if (draft.appliesTo.some((k) => !(SPLITTABLE_KINDS as readonly string[]).includes(k))) return "That charge type cannot be split.";
  if (draft.propertyId && !ctx.propertyInWorkspace) return "That house is not in this workspace.";
  if (draft.payeeKind === "member" && !ctx.payeeIsWorkspaceMember) return "A team member must be on this workspace's team.";
  if (draft.payeeKind === "vendor" && !ctx.payeeIsVendorWithConnectedAccount) return "A vendor must have a PropLane account with payouts set up.";
  // The total percent a single payment can see may never pass 100%: check each charge kind against the rules that would apply together.
  const sameScope = ctx.activeRules.filter((r) => r.ruleKind === "percent" && r.propertyId === draft.propertyId);
  if (draft.ruleKind === "percent") {
    for (const kind of draft.appliesTo) {
      const already = sameScope.filter((r) => r.appliesTo.includes(kind)).reduce((s, r) => s + (r.bps ?? 0), 0);
      if (already + (draft.bps ?? 0) > 10_000) return "Splits add up to more than 100% of the owner's share.";
    }
  }
  return null;
}

/** The pro-rata share of a split to reverse after a refund: cumulative target, never more than the share, and the whole at a full refund. */
export function reversalTargetCents(input: { shareCents: number; ownerCents: number; refundedOwnerCents: number }): number {
  const { shareCents, ownerCents, refundedOwnerCents } = input;
  if (ownerCents <= 0 || refundedOwnerCents <= 0) return 0;
  if (refundedOwnerCents >= ownerCents) return shareCents;
  // Round half up on the product, matching the SQL refund split.
  return Math.min(shareCents, Math.floor((shareCents * refundedOwnerCents * 2 + ownerCents) / (ownerCents * 2)));
}
