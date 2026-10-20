import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SHARED_LINE_ROUTING_ORDER,
  type RoutingDecision,
  type SharedLineCandidate,
  type SharedLineInbound,
  type SharedLineSession,
} from "@/lib/one-number/contracts";
import {
  findApplicantCandidates,
  findEntryCodeCandidate,
  findResidentCandidates,
  findReturningProspectCandidates,
  findTeamMemberCandidates,
  findVendorJobCandidates,
  findWorkspaceProspectCandidate,
} from "@/lib/one-number/router-lookups.server";
import { saveSharedLinePending, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { handleUnknownSenderInbound } from "@/lib/one-number/onboarding/unknown-sender.server";
import { parseVendorDispatchReply } from "@/lib/vendor-dispatch/reply-parse";

export {
  findApplicantCandidates,
  findEntryCodeCandidate,
  findResidentCandidates,
  findReturningProspectCandidates,
  findTeamMemberCandidates,
  findVendorJobCandidates,
};

// ---------------------------------------------------------------------------
// Pure decision helpers (no db): exported so the rules can be tested directly.
// ---------------------------------------------------------------------------

/** team_member / vendor_job / tenant journey (resident > applicant > prospect). One person, one place per workspace per group. */
function candidateGroup(c: SharedLineCandidate): "manager" | "vendor" | "tenant" {
  if (c.role === "manager") return "manager";
  if (c.role === "vendor") return "vendor";
  return "tenant";
}

const priority = (c: SharedLineCandidate) => SHARED_LINE_ROUTING_ORDER.indexOf(c.reason);

/**
 * Collapse candidates to at most one per (workspace, group), keeping the one the
 * routing order ranks first, then sort by that order. A phone that is a
 * resident AND a vendor in one workspace stays two candidates (a different agent
 * answers each); a phone that is an applicant AND a returning prospect there is
 * one tenant-journey candidate.
 */
export function dedupeCandidates(candidates: SharedLineCandidate[]): SharedLineCandidate[] {
  const sorted = [...candidates].sort((a, b) => priority(a) - priority(b));
  const seen = new Set<string>();
  const out: SharedLineCandidate[] = [];
  for (const c of sorted) {
    const key = `${c.workspaceId}:${candidateGroup(c)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const candidateKey = (c: Pick<SharedLineCandidate, "workspaceId" | "role">) => `${c.workspaceId}:${c.role}`;

const FILLER = new Set([
  "the", "a", "an", "about", "is", "it", "its", "this", "that", "my", "your", "job", "room", "at", "for", "of", "and", "or",
  "one", "please", "pls", "re", "regarding", "on", "in", "to",
]);
const STREET_WORDS = new Set([
  "ave", "avenue", "st", "street", "rd", "road", "blvd", "boulevard", "dr", "drive", "ln", "lane", "way", "ct", "court",
  "pl", "place", "house", "home", "apt", "unit", "the",
]);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** The words of a label that actually tell two houses apart. */
function distinctiveTokens(label: string): string[] {
  return tokens(label).filter((t) => !STREET_WORDS.has(t));
}

/** A leading street number: "5259", "4709a". */
function streetNumber(label: string): string | null {
  const first = tokens(label)[0] ?? "";
  return /^\d+[a-z]?$/.test(first) ? first : null;
}

/** Does the text name this candidate's house? All its distinctive words, or its street number. */
export function textNamesCandidate(body: string, candidate: SharedLineCandidate): boolean {
  const words = new Set(tokens(body));
  const distinct = distinctiveTokens(candidate.label);
  if (distinct.length === 0) return false;
  if (distinct.every((t) => words.has(t))) return true;
  const number = streetNumber(candidate.label);
  return number !== null && words.has(number);
}

const VENDOR_WORDS =
  /\b(job|jobs|invoice|invoiced|arrived|arrive|omw|on my way|completed|finished|quote|estimate|parts|visit|work order|service call)\b/i;
const TENANT_WORDS =
  /\b(rent|my room|lease|roommate|roommates|housemate|landlord|deposit|move[- ]?out|move[- ]?in|my unit|laundry|wifi|wi-fi|neighbor|noise)\b/i;

/** Which candidates the wording of the text points at, by role. Empty when it is neutral or mixed. */
export function candidatesFittingWording(body: string, candidates: SharedLineCandidate[]): SharedLineCandidate[] {
  const vendor = VENDOR_WORDS.test(body);
  const tenant = TENANT_WORDS.test(body);
  if (vendor === tenant) return [];
  return candidates.filter((c) => (vendor ? c.role === "vendor" : c.role === "resident" || c.role === "applicant" || c.role === "prospect"));
}

/**
 * Does the text clearly settle one candidate? House named beats wording; wording
 * narrows a house match that names several. Null when it does not.
 */
export function pickCandidateFromText(body: string, candidates: SharedLineCandidate[]): SharedLineCandidate | null {
  const named = candidates.filter((c) => textNamesCandidate(body, c));
  if (named.length === 1) return named[0];
  const pool = named.length > 1 ? named : candidates;
  const worded = candidatesFittingWording(body, pool);
  return worded.length === 1 ? worded[0] : null;
}

/** The text a person sends back to a "Is this about A or B?" question: "1", "2", or a house name. */
export function resolvePendingAnswer(
  body: string,
  asked: SharedLineCandidate[],
  fresh: SharedLineCandidate[],
): SharedLineCandidate | null {
  const text = body.trim();
  let chosen: SharedLineCandidate | null = null;
  if (/^[1-9]$/.test(text)) {
    chosen = asked[Number(text) - 1] ?? null;
  } else {
    const words = tokens(text).filter((t) => !FILLER.has(t));
    if (words.length > 0) {
      const hits = asked.filter((c) => {
        const labelWords = new Set(tokens(c.label));
        return words.every((w) => labelWords.has(w));
      });
      if (hits.length === 1) chosen = hits[0];
    }
  }
  if (!chosen) return null;
  // Re-check against who this phone is NOW: a stored candidate is a hint, never authority.
  return fresh.find((c) => candidateKey(c) === candidateKey(chosen!)) ?? null;
}

/**
 * What this candidate may be CALLED in a text to this phone. A vendor reads the general area, never the street: the
 * candidate exists while the job is only offered. `label` stays the house for matching, so naming the street still
 * routes - it is only what we say back that is narrowed.
 */
export function spokenLabelFor(candidate: SharedLineCandidate): string {
  return candidate.role === "vendor" ? candidate.generalArea || candidate.label : candidate.label;
}

function phraseFor(candidate: SharedLineCandidate): string {
  return candidate.role === "vendor" ? `your job at ${spokenLabelFor(candidate)}` : candidate.label;
}

/** "Is this about 5259 Brooklyn or your job at Capitol Hill?" Labels are houses, areas or workspaces, never people. */
export function buildDisambiguationQuestion(candidates: SharedLineCandidate[]): string {
  const duplicate = new Set(
    candidates.map((c) => spokenLabelFor(c)).filter((label, i, all) => all.indexOf(label) !== i),
  );
  const labels = candidates.map((c) => {
    const spoken = spokenLabelFor(c);
    if (!duplicate.has(spoken)) return phraseFor(c);
    if (c.role === "vendor") return `a job at ${spoken}`;
    if (c.role === "manager") return `the ${spoken} team`;
    return `your room at ${spoken}`;
  });
  const head = labels.slice(0, -1).join(", ");
  return `Is this about ${head} or ${labels[labels.length - 1]}?`;
}

/** What a bare vendor answer is for: YES / NO / BUSY answer an offer, DONE closes an accepted job. A job number (#7) names its own run. */
export function dispatchAnswerKind(body: string): "offer" | "accepted" | null {
  const parsed = parseVendorDispatchReply(body);
  if (!parsed || parsed.kind === "invoice") return null;
  if ("handle" in parsed && parsed.handle != null) return null;
  return parsed.kind === "done" ? "accepted" : "offer";
}

/**
 * The pure core of routing. Given every workspace this phone legitimately
 * belongs to, pick one, or say we must ask. Order of evidence:
 * 1. a reply to a pending question, 2. one candidate, 3. the text names a house
 * or its wording fits one role, 4. the thread's current team and role, 5. ask.
 */
export function decideFromCandidates(
  input: { body: string; candidates: SharedLineCandidate[]; session: SharedLineSession | null },
): { kind: "routed"; candidate: SharedLineCandidate } | { kind: "ambiguous"; candidates: SharedLineCandidate[]; question: string } | { kind: "none" } {
  const candidates = dedupeCandidates(input.candidates);
  if (candidates.length === 0) return { kind: "none" };
  const session = input.session;

  if (session?.pendingCandidates?.length) {
    const answered = resolvePendingAnswer(input.body, session.pendingCandidates, candidates);
    if (answered) return { kind: "routed", candidate: answered };
  }
  if (candidates.length === 1) return { kind: "routed", candidate: candidates[0] };

  const fitting = pickCandidateFromText(input.body, candidates);
  if (fitting) return { kind: "routed", candidate: fitting };

  // A bare YES / NO / DONE answers whatever is waiting on this phone, and that outranks the sticky thread:
  // the vendor who was last talking to team A still means team B's open offer.
  const waitingOn = dispatchAnswerKind(input.body);
  if (waitingOn) {
    const live = candidates.filter((c) => c.role === "vendor" && c.liveDispatch?.includes(waitingOn));
    if (live.length === 1) return { kind: "routed", candidate: live[0] };
    if (live.length > 1) return { kind: "ambiguous", candidates: live, question: buildDisambiguationQuestion(live) };
  }

  if (session?.currentWorkspaceId) {
    const sticky =
      candidates.find((c) => c.workspaceId === session.currentWorkspaceId && c.role === session.activeRole) ??
      (() => {
        const inWorkspace = candidates.filter((c) => c.workspaceId === session.currentWorkspaceId);
        return inWorkspace.length === 1 ? inWorkspace[0] : undefined;
      })();
    if (sticky) return { kind: "routed", candidate: sticky };
  }
  return { kind: "ambiguous", candidates, question: buildDisambiguationQuestion(candidates) };
}

// ---------------------------------------------------------------------------
// The db-backed router.
// ---------------------------------------------------------------------------

export type SharedLineRouteOptions = {
  /** Shadow mode: read only. No session write, no lead creation. */
  dryRun?: boolean;
  /**
   * Workspaces that text from a number of their own. They never answer on the shared line: a phone
   * whose only matches are these gets `dedicatedRedirect`, and a mixed phone routes among the rest.
   */
  dedicatedWorkspaceIds?: readonly string[];
  /**
   * Treat the sender as a stranger for this one text: no workspace is looked up, so the lead agent answers from the
   * PropLane catalog. For a resident asking for a new house; the caller decided that from the text, never the model.
   */
  asProspect?: boolean;
};

export type SharedLineRouteResult = {
  decision: RoutingDecision;
  /** The Unassigned-leads reply to text back, when the decision is `unassigned`. */
  unassignedReply: string | null;
  /** Several texts to send in order (the DEMO's bubbles); `unassignedReply` is them joined. */
  unassignedReplies?: string[];
  /** One real listing photo the reply carries (https), when the lead agent attached one. */
  unassignedMediaUrls?: string[];
  /** The reply as separate texts, each with its own photo (the lead agent's room offers). */
  unassignedBubbles?: Array<{ body: string; mediaUrl?: string }>;
  /**
   * Set when every match is a workspace with its own number: the caller tells the person to text that
   * number instead. `decision` is then a bare `unassigned` with no lead and no reply.
   */
  dedicatedRedirect?: SharedLineCandidate;
};

/** Every lookup, in routing order. A failing lookup is an empty one. */
export async function gatherCandidates(db: SupabaseClient, inbound: SharedLineInbound): Promise<SharedLineCandidate[]> {
  const settle = async (read: Promise<SharedLineCandidate[]>) => {
    try {
      return await read;
    } catch {
      return [] as SharedLineCandidate[];
    }
  };
  const [team, resident, vendor, applicant, prospect] = await Promise.all([
    settle(findTeamMemberCandidates(db, inbound.fromPhone)),
    settle(findResidentCandidates(db, inbound.fromPhone)),
    settle(findVendorJobCandidates(db, inbound.fromPhone)),
    settle(findApplicantCandidates(db, inbound.fromPhone)),
    settle(findReturningProspectCandidates(db, inbound.fromPhone)),
  ]);
  return [...team, ...resident, ...vendor, ...applicant, ...prospect];
}

/**
 * Decide which workspace (and role) an inbound text on the shared line belongs
 * to. Unless `dryRun`, remembers the answer on the phone's session and hands a
 * new, code-less prospect to the Unassigned-leads queue.
 */
export async function routeSharedLineInboundWithReply(
  db: SupabaseClient,
  inbound: SharedLineInbound,
  session: SharedLineSession | null,
  options: SharedLineRouteOptions = {},
): Promise<SharedLineRouteResult> {
  const candidates = options.asProspect ? [] : await gatherCandidates(db, inbound);
  // An entry code is the way in for a stranger (spec step 6). It also settles a RETURNING PROSPECT who
  // texts another team's flyer code. For anyone with a stronger tie (team, resident, vendor, applicant)
  // the order stands and the code is ignored.
  let all = candidates;
  const strangerOrProspect = candidates.every((c) => c.reason === "returning_prospect");
  if (strangerOrProspect) {
    const code = await findEntryCodeCandidate(db, inbound.body).catch(() => null);
    if (code && !candidates.some((c) => c.workspaceId === code.workspaceId)) all = [code];
  }

  const dedicated = new Set(options.dedicatedWorkspaceIds ?? []);
  if (dedicated.size > 0 && all.length > 0) {
    const served = all.filter((c) => !dedicated.has(c.workspaceId));
    if (served.length === 0) {
      const own = dedupeCandidates(all);
      const target = pickCandidateFromText(inbound.body, own) ?? own[0];
      return { decision: { kind: "unassigned", role: "prospect", leadId: null }, unassignedReply: null, dedicatedRedirect: target };
    }
    all = served;
  }

  const decided = decideFromCandidates({ body: inbound.body, candidates: all, session });

  if (decided.kind === "routed") {
    if (!options.dryRun) {
      await saveSharedLineRoute(db, inbound.phoneKey, { workspaceId: decided.candidate.workspaceId, role: decided.candidate.role });
    }
    return { decision: { kind: "routed", ...decided.candidate }, unassignedReply: null };
  }
  if (decided.kind === "ambiguous") {
    if (!options.dryRun) await saveSharedLinePending(db, inbound.phoneKey, decided.candidates);
    return {
      decision: { kind: "ambiguous", candidates: decided.candidates, question: decided.question },
      unassignedReply: null,
    };
  }

  // Step 7: nobody knows this number. Shadow mode only reports it.
  if (options.dryRun) return { decision: { kind: "unassigned", role: "prospect", leadId: null }, unassignedReply: null };
  const turn = await handleUnknownSenderInbound(db, inbound);
  if (turn.assignedWorkspaceId) {
    const assigned = await findWorkspaceProspectCandidate(db, turn.assignedWorkspaceId);
    if (assigned && dedicated.has(assigned.workspaceId)) {
      // The room the prospect picked belongs to a team with its own number: send them there.
      return { decision: { kind: "unassigned", role: "prospect", leadId: turn.leadId }, unassignedReply: null, dedicatedRedirect: assigned };
    }
    if (assigned) {
      await saveSharedLineRoute(db, inbound.phoneKey, { workspaceId: assigned.workspaceId, role: assigned.role });
      return { decision: { kind: "routed", ...assigned }, unassignedReply: null };
    }
  }
  return {
    decision: { kind: "unassigned", role: "prospect", leadId: turn.leadId },
    unassignedReply: turn.reply,
    ...(turn.replies && turn.replies.length > 1 ? { unassignedReplies: turn.replies } : {}),
    ...(turn.mediaUrls?.length ? { unassignedMediaUrls: turn.mediaUrls } : {}),
    ...(turn.bubbles && turn.bubbles.length > 1 ? { unassignedBubbles: turn.bubbles } : {}),
  };
}

export async function routeSharedLineInbound(
  db: SupabaseClient,
  inbound: SharedLineInbound,
  session: SharedLineSession | null,
  options: SharedLineRouteOptions = {},
): Promise<RoutingDecision> {
  return (await routeSharedLineInboundWithReply(db, inbound, session, options)).decision;
}
