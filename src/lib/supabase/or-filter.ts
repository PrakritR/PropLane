/**
 * Safe construction of PostgREST `or()` filter strings.
 *
 * `or()` takes a STRING, not bound parameters: `,` separates clauses and `()`
 * groups them. Every resident scope filter in this codebase was built by
 * interpolating an identity straight into that string, which makes the value
 * query syntax rather than data — the one place in an otherwise carefully
 * scoped stack where that happens. An email local-part may legally contain both
 * characters when quoted.
 *
 * Two rules, both enforced here:
 *
 * 1. **Values are quoted.** PostgREST accepts a double-quoted value, with `"`
 *    and `\` backslash-escaped inside it, so a comma or paren in the value can
 *    no longer end a clause.
 * 2. **It fails closed.** With no identity at all the old form produced
 *    `resident_user_id.eq.,resident_email.eq.` — a malformed predicate whose
 *    behaviour is not obviously restrictive. `orFilterForIdentity` returns
 *    `null` instead, and the caller must return no rows rather than issue a
 *    query. A scope filter that cannot name an identity must match nothing.
 */

/** Quote one value for use inside a PostgREST filter string. */
export function postgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * An `or()` clause over `column.eq.value` pairs, skipping empty values.
 *
 * Returns `null` when NO pair has a usable value — the caller must then return
 * no rows, never fall through to an unfiltered query.
 */
export function orFilterForIdentity(
  pairs: Array<readonly [column: string, value: string | null | undefined]>,
): string | null {
  const clauses = pairs
    .map(([column, value]) => [column, (value ?? "").trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([column, value]) => `${column}.eq.${postgrestFilterValue(value)}`);
  return clauses.length > 0 ? clauses.join(",") : null;
}

/**
 * Split an `or()` filter string back into `[column, operator, value]` triples,
 * undoing the quoting above.
 *
 * This lives beside the builder on purpose. Several test doubles stand in for
 * PostgREST and parse these strings themselves; when they did it with
 * `expr.split(",")` they modelled a PostgREST that does not exist — one where a
 * comma in a value ends a clause — which is precisely the bug the builder
 * fixes. One parser next to one builder keeps the fakes honest, and the
 * round-trip is unit-tested.
 */
export function parseOrFilterClauses(expr: string): Array<{ column: string; operator: string; value: string }> {
  const clauses: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (inQuotes && ch === "\\") {
      current += ch + (expr[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      clauses.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) clauses.push(current);

  return clauses.flatMap((clause) => {
    const first = clause.indexOf(".");
    if (first < 0) return [];
    const second = clause.indexOf(".", first + 1);
    if (second < 0) return [];
    const column = clause.slice(0, first);
    const operator = clause.slice(first + 1, second);
    const raw = clause.slice(second + 1);
    const value =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
        : raw;
    return [{ column, operator, value }];
  });
}
