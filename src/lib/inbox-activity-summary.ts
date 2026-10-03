/** Compact display of a server-stamped automated notice. Human messages never use this. */
export function inboxActivitySummary(subject: string | undefined, body: string): { title: string; property?: string; href?: string } {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const link = body.match(/https?:\/\/[^\s<>]+/)?.[0]?.replace(/[).,;]+$/, "");
  const title = subject?.trim() || lines.find((line) => !/^(hi\b|hello\b|when:|with:|where:|property:|details:|view\b|https?:|proplane$)/i.test(line)) || "Activity";
  return { title, property: lines.find((line) => /^property:/i.test(line))?.replace(/^property:\s*/i, ""), href: link };
}
