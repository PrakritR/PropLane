/** Compact display of a server-stamped automated notice. Human messages never use this. */
export function inboxActivitySummary(subject: string | undefined, body: string): { title: string; property?: string; href?: string } {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const link = body.match(/https?:\/\/[^\s<>]+/)?.[0]?.replace(/[).,;]+$/, "");
  // Recognize the exact charge-created template only. The stored amount is
  // already dollars; this formats it, never derives a charge from other facts.
  const charge = body.match(/(?:The|A new) (\$?[\d,]+(?:\.\d{1,2})?) charge for [“"]([^”"]+)[”"](?: at ([^\n]+?))? was (?:created|added)\./);
  const amount = charge ? Number(charge[1]!.replace(/[$,]/g, "")) : NaN;
  const chargeTitle = charge && Number.isFinite(amount) ? `${charge[2]} ${new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(amount)} created` : undefined;
  const title = chargeTitle || subject?.trim() || lines.find((line) => !/^(hi\b|hello\b|when:|with:|where:|property:|details:|view\b|https?:|proplane$)/i.test(line)) || "Activity";
  return { title, property: charge?.[3] || lines.find((line) => /^property:/i.test(line))?.replace(/^property:\s*/i, ""), href: link };
}
