/**
 * The text a manager's work number sends for a service link (vendor-work-share-1006). Composed on
 * the server from the service's PUBLIC view only - the trade, the general area and the title - so
 * the text, like the page behind it, never carries the street address, unit or resident.
 */
export function serviceShareSmsText(params: {
  recipientName?: string | null;
  managerName?: string | null;
  trade: string;
  area: string;
  title: string;
  linkUrl: string;
}): string {
  const first = params.recipientName?.trim().split(/\s+/)[0] ?? "";
  const greeting = first ? `Hi ${first} - ` : "Hi - ";
  const who = params.managerName?.trim() ? params.managerName.trim() : "A property manager";
  const trade = params.trade.trim().toLowerCase() || "maintenance";
  const where = params.area.trim() && params.area.trim() !== "Nearby" ? ` in ${params.area.trim()}` : "";
  const what = params.title.trim() ? ` (${params.title.trim().slice(0, 60)})` : "";
  return `${greeting}${who} has a ${trade} job${where}${what}. Details and bid: ${params.linkUrl}`;
}
