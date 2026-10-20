/**
 * A slot label as a prospect should read it in a text: the stored label ends "· 2026-10-22 Pacific" (a date key and a middle
 * dot, which turns the whole text into UCS-2 and costs extra segments). The range already names the day.
 */
export function smsTourLabel(label: string): string {
  return label.replace(/\s*[·•]\s*\d{4}-\d{2}-\d{2}\s+Pacific\s*$/i, "").replace(/[·•]/g, "-").trim();
}
