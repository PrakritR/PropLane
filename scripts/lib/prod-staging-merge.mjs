/**
 * Three-way merge planner for a production → staging refresh.
 *
 * Inputs are per primary key: whether the row exists in current prod, current
 * staging, and the last applied prod snapshot, plus equality to that snapshot.
 *
 * Conflict rule (captain): when both sides changed the same row, production wins.
 * Staging-only rows (never in a snapshot) are kept.
 */

export const PROD_REF = "qahnczmilgptcedaqype";
export const STAGING_REF = "xwszcafaontidfgznlxd";

/**
 * @param {{
 *   inProd: boolean,
 *   inStaging: boolean,
 *   inSnapshot: boolean,
 *   prodEqualsSnapshot?: boolean,
 *   stagingEqualsSnapshot?: boolean,
 * }} row
 * @returns {"noop" | "insert-prod" | "update-prod" | "keep-staging" | "delete-staging"}
 */
export function decideRowFate(row) {
  const inProd = Boolean(row.inProd);
  const inStaging = Boolean(row.inStaging);
  const inSnapshot = Boolean(row.inSnapshot);
  const prodEqualsSnapshot = row.prodEqualsSnapshot !== false;
  const stagingEqualsSnapshot = row.stagingEqualsSnapshot !== false;

  if (!inProd && !inStaging) return "noop";

  if (!inProd) {
    return inSnapshot ? "delete-staging" : "keep-staging";
  }

  if (!inStaging) return "insert-prod";

  if (!inSnapshot) return "update-prod";

  if (prodEqualsSnapshot && stagingEqualsSnapshot) return "noop";
  if (prodEqualsSnapshot && !stagingEqualsSnapshot) return "keep-staging";
  return "update-prod";
}

export function assertCloneEndpoint({ kind, url }) {
  const value = String(url || "");
  if (kind === "prod") {
    if (!value.includes(`${PROD_REF}.supabase.co`) && !value.includes(PROD_REF)) {
      throw new Error(`prod endpoint must name ${PROD_REF}`);
    }
    if (value.includes(STAGING_REF)) {
      throw new Error("prod endpoint must not name the staging project");
    }
    return;
  }
  if (kind === "staging") {
    if (!value.includes(`${STAGING_REF}.supabase.co`) && !value.includes(STAGING_REF)) {
      throw new Error(`staging endpoint must name ${STAGING_REF}`);
    }
    if (value.includes(PROD_REF)) {
      throw new Error("staging endpoint must not name the live production project");
    }
    return;
  }
  throw new Error(`unknown endpoint kind: ${kind}`);
}
