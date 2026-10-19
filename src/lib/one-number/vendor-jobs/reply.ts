/**
 * The fixed text a vendor gets on the PropLane line. No model: every number and word comes from the job list, the
 * link, or the copy below. One GSM-7 body, a handful of lines.
 */
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import type { OpenJobNear } from "@/lib/open-jobs-near.server";

export const VENDOR_LINE_COPY = {
  welcome: "Hi, this is PropLane. Reply STOP to opt out.",
  anyArea: "right now. Text me your neighborhood or zip to narrow them:",
  none: "No open jobs match yet. I saved your details and you will see new ones as they post.",
  help: "Text me what work you do and where, like 'plumbing in Ballard', and I will show open jobs.",
  signUp: "Create your free vendor account to request jobs:",
  findWork: "Request jobs in Find work:",
  linkSent: "Your sign-up link is in my earlier text, or reply LINK for a new one.",
  linkBusy: "Too many links just now. Try again in a bit.",
} as const;

const MAX_REPLY_CHARS = 460;

function jobLine(n: number, job: OpenJobNear): string {
  const bits = [job.trade, job.area, job.when !== "Anytime" ? job.when : "", job.budget].filter(Boolean);
  return `${n}. ${bits.join(", ")}`;
}

export type VendorLineLink =
  | { kind: "signup"; url: string }
  | { kind: "findwork"; url: string }
  | { kind: "earlier" }
  | { kind: "busy" }
  | { kind: "none" };

export function composeVendorJobsReply(input: {
  firstReply: boolean;
  jobs: OpenJobNear[];
  total: number;
  /** "Ballard" / "the University of Washington campus": what the vendor named, for the header. */
  placeLabel: string | null;
  tradeLabel: string | null;
  filteredByArea: boolean;
  unknownArea: string | null;
  link: VendorLineLink;
}): string {
  const lines: string[] = [];
  if (input.firstReply) lines.push(VENDOR_LINE_COPY.welcome);
  const what = input.tradeLabel ? `${input.tradeLabel.toLowerCase()} jobs` : "jobs";
  const where = input.placeLabel ? ` near ${input.placeLabel}` : input.unknownArea ? ` near ${input.unknownArea}` : "";
  if (input.jobs.length === 0) {
    lines.push(`No open ${what}${where} right now. ${VENDOR_LINE_COPY.none}`);
  } else {
    lines.push(input.filteredByArea || input.placeLabel ? `Open ${what}${where}:` : `Open ${what} ${VENDOR_LINE_COPY.anyArea}`);
    input.jobs.forEach((job, i) => lines.push(jobLine(i + 1, job)));
    if (input.total > input.jobs.length) lines.push(`+${input.total - input.jobs.length} more.`);
  }
  if (input.link.kind === "signup") lines.push(`${VENDOR_LINE_COPY.signUp} ${input.link.url}`);
  else if (input.link.kind === "findwork") lines.push(`${VENDOR_LINE_COPY.findWork} ${input.link.url}`);
  else if (input.link.kind === "earlier") lines.push(VENDOR_LINE_COPY.linkSent);
  else if (input.link.kind === "busy") lines.push(VENDOR_LINE_COPY.linkBusy);
  let text = toGsm7(lines.join("\n"));
  // Over the cap: drop job lines from the end, never the link.
  while (text.length > MAX_REPLY_CHARS && lines.some((l) => /^\d\. /.test(l))) {
    const idx = lines.map((l) => /^\d\. /.test(l)).lastIndexOf(true);
    lines.splice(idx, 1);
    text = toGsm7(lines.join("\n"));
  }
  return text;
}

export function composeVendorHelpReply(input: { firstReply: boolean; link: VendorLineLink }): string {
  const lines: string[] = [];
  if (input.firstReply) lines.push(VENDOR_LINE_COPY.welcome);
  lines.push(VENDOR_LINE_COPY.help);
  if (input.link.kind === "signup") lines.push(`${VENDOR_LINE_COPY.signUp} ${input.link.url}`);
  else if (input.link.kind === "findwork") lines.push(`${VENDOR_LINE_COPY.findWork} ${input.link.url}`);
  else if (input.link.kind === "earlier") lines.push(VENDOR_LINE_COPY.linkSent);
  else if (input.link.kind === "busy") lines.push(VENDOR_LINE_COPY.linkBusy);
  return toGsm7(lines.join("\n"));
}
