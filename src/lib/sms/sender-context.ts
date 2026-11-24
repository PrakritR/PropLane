import { listingsNamedIn, parseStreetLine } from "@/lib/one-number/house-redirect";
import { serviceWorkspaceLabel } from "@/lib/service/service-label";

/**
 * Which hat is a VERIFIED sender wearing on this text? (captain, Nov 23: the production incident where his reply to an
 * Assistant notice about three PropLane-managed homes was answered from his own self-serve workspace.)
 *
 * A sender can hold several contexts at once:
 *   manager   a workspace they own (self-serve) or hold a seat on
 *   admin     every PropLane-managed (`is_service`) workspace, for a platform admin
 *   resident  a residency (their own home)
 *
 * This module is the PURE decision: no database, no model. The server file loads the contexts (re-derived from the
 * database on every text) and the sticky state, and runs the chosen registry. Nothing here widens access: a target is
 * only ever one of the `contexts` the caller proved, and a target that is no longer in that list is dropped.
 *
 * Order, first match wins (docs/agents/one-number.md § Who is the sender texting as):
 *   0. a one-person sender is never asked (fewer than two contexts = `unchanged`)
 *   1. an answer to our question ("1", "2", "manager", a workspace name) replays the held text
 *   2. "switch" / "menu" shows the menu
 *   3. explicit words: "manager:" "resident:" "admin:" prefixes, "as manager", "switch to <workspace or home>"; sticky
 *   4. a text that names a home resolves to the workspace that holds it, among the sender's own contexts
 *   5. a pick the sender MADE explicitly (a bare "switch to X", the menu's answer, a role word), for 12 hours from it
 *   6. the number they texted, when it is a workspace's OWN work number: that workspace owns the text
 *   7. a reply to a text we just sent about a workspace inherits that workspace (newer than the last pick)
 *   8. the last pick we INFERRED, for 12 hours
 *   9. ONE question listing only the roles they hold; the text waits for the answer
 *
 * 7 and 8 are reached only on the shared PropLane line, where no number names a workspace: a text to a workspace's own
 * dedicated number is about that workspace unless the sender said otherwise (1-5), so neither an unrelated notice from
 * another workspace nor a context we merely inferred can route it - and bill it - elsewhere. An explicit pick does
 * outrank the number: "switch to resident" then "my sink leaks" is one request, not two. Its 12 hours run from the
 * pick itself, so texting all day never makes it permanent.
 */

export const SENDER_STICKY_TTL_MS = 12 * 60 * 60 * 1000;
export const SENDER_QUESTION_TTL_MS = 30 * 60 * 1000;

export type ServiceWorkspaceLite = { id: string; name: string; ownerUserId: string; isDefault: boolean };

export type SenderContext =
  | {
      kind: "manager";
      key: string;
      workspaceId: string;
      ownerUserId: string;
      name: string;
      isDefault: boolean;
      isService: boolean;
      /** `owner`: their own workspace; `seat`: an accepted teammate seat (delegated access, houses and modules re-derived). */
      basis: "owner" | "seat";
      viewerSeat: boolean;
    }
  | { kind: "admin"; key: "admin"; workspaces: ServiceWorkspaceLite[] }
  | { kind: "resident"; key: string; workspaceId: string; ownerUserId: string; propertyId: string | null; label: string };

/** A choice, serializable for the sticky row. `admin` may be narrowed to one PropLane-managed workspace. */
export type SenderTarget = { key: string; workspaceId?: string | null };

/** A home the sender can reach, with the target a text naming it resolves to. */
export type SenderHome = { id: string; address: string; title: string; buildingName: string; neighborhood: string; target: SenderTarget };

export type SenderPending = { options: SenderTarget[]; body: string; messageSid: string; at: number };
export type SenderSticky = {
  target: SenderTarget;
  at: number;
  /**
   * When the sender SAID it (a switch word, the menu answer), rather than us inferring it from a notice or a routed
   * turn. The explicit window runs from that moment and is never renewed by a later text it routed.
   */
  explicitAt?: number;
};

export type SenderDecision =
  | { kind: "unchanged" }
  | {
      kind: "run";
      target: SenderTarget;
      /** The text the agent answers: the held text after an answer, the text without its switch words otherwise. */
      body: string;
      /** The reply starts with this tag (the context was chosen or changed); null when it did not change. */
      tag: string | null;
      source: "answer" | "switch" | "named" | "notice" | "sticky" | "number";
    }
  | {
      kind: "reply";
      text: string;
      /** Remember this pick (a switch with nothing else in the text). */
      sticky?: SenderTarget;
      /** Hold this text and the options until the answer arrives. */
      pending?: { options: SenderTarget[]; body: string; messageSid: string };
    };

export type SenderContextInput = {
  body: string;
  messageSid: string;
  contexts: readonly SenderContext[];
  sticky: SenderSticky | null;
  pending: SenderPending | null;
  /** The workspace whose own work number the text arrived on; null on the PropLane line. */
  numberDefault: SenderTarget | null;
  now: number;
  loadHomes: () => Promise<readonly SenderHome[]>;
  /** The workspace of the newest text we sent THIS phone, and when. */
  loadNotice: () => Promise<{ workspaceId: string; at: number } | null>;
};

type Role = "manager" | "resident" | "admin";

/** The same choice: same context key, and the same admin workspace (or none) narrowed inside it. */
export const sameTarget = (a: SenderTarget | null, b: SenderTarget | null): boolean =>
  Boolean(a && b && a.key === b.key && (a.workspaceId ?? null) === (b.workspaceId ?? null));

/** The context a target names, with the admin workspace it narrows to; null when the sender no longer holds it. */
export function resolveSenderTarget(
  contexts: readonly SenderContext[],
  target: SenderTarget,
): { context: SenderContext; workspace: ServiceWorkspaceLite | null } | null {
  const context = contexts.find((c) => c.key === target.key);
  if (!context) return null;
  if (context.kind !== "admin") return { context, workspace: null };
  if (!target.workspaceId) return { context, workspace: null };
  const workspace = context.workspaces.find((w) => w.id === target.workspaceId);
  return workspace ? { context, workspace } : null;
}

function nameOf(context: SenderContext, workspace: ServiceWorkspaceLite | null): string {
  if (context.kind === "manager") return context.name;
  if (context.kind === "admin") return workspace ? workspace.name : "";
  return context.label;
}

/** "Manager · 1. Ambika" / "Resident · 5257 Brooklyn" / "Admin". */
export function senderTargetLabel(contexts: readonly SenderContext[], target: SenderTarget): string {
  const resolved = resolveSenderTarget(contexts, target);
  if (!resolved) return "";
  const { context, workspace } = resolved;
  const role = context.kind === "manager" ? "Manager" : context.kind === "resident" ? "Resident" : "Admin";
  const managers = contexts.filter((c) => c.kind === "manager").length;
  const residents = contexts.filter((c) => c.kind === "resident").length;
  const name = nameOf(context, workspace);
  const wantsName = context.kind === "manager" ? managers > 1 : context.kind === "resident" ? residents > 1 || Boolean(name) : Boolean(workspace);
  return wantsName && name ? `${role} · ${name}` : role;
}

export const senderTargetTag = (contexts: readonly SenderContext[], target: SenderTarget): string => {
  const label = senderTargetLabel(contexts, target);
  return label ? `${label}:` : "";
};

/** Every selectable target, in menu order: managers, residencies, admin. */
export function senderMenuOptions(contexts: readonly SenderContext[]): SenderTarget[] {
  const order = { manager: 0, resident: 1, admin: 2 } as const;
  return [...contexts].sort((a, b) => order[a.kind] - order[b.kind]).map((c) => ({ key: c.key }));
}

export function senderQuestionText(contexts: readonly SenderContext[], options: readonly SenderTarget[] = senderMenuOptions(contexts)): string {
  const held = options.map((o) => resolveSenderTarget(contexts, o)?.context).filter((c): c is SenderContext => Boolean(c));
  const managers = held.filter((c) => c.kind === "manager").length;
  const residents = held.filter((c) => c.kind === "resident").length;
  const parts: string[] = [];
  if (managers) parts.push(managers > 1 ? "one of your manager workspaces" : "your manager workspace");
  if (residents) parts.push(residents > 1 ? "one of your homes as a resident" : "your home as a resident");
  if (held.some((c) => c.kind === "admin")) parts.push("PropLane admin");
  const phrase = parts.length <= 1 ? (parts[0] ?? "this") : `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
  const choices = options
    .map((o, i) => {
      const resolved = resolveSenderTarget(contexts, o);
      if (!resolved) return null;
      const { context } = resolved;
      const role = context.kind === "manager" ? "Manager" : context.kind === "resident" ? "Resident" : "Admin";
      const name = context.kind === "admin" ? "" : nameOf(context, null);
      const several = context.kind === "manager" ? managers > 1 : context.kind === "resident" ? residents > 1 : false;
      return `${i + 1} ${role}${several && name ? ` (${name})` : ""}`;
    })
    .filter(Boolean)
    .join(" · ");
  return `Is this about ${phrase}? Reply ${choices}`;
}

// --- word parsing ---------------------------------------------------------------------------------------------------

const GENERIC_NAME_WORDS = new Set(["my", "the", "workspace", "properties", "property", "llc", "inc", "co", "team", "and", "of", "home", "homes", "house"]);
const tokens = (value: string): string[] => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** Does the text say this workspace's distinctive name? "My workspace" has none, so only a number or role word picks it. */
export function textNamesWorkspace(text: string, name: string): boolean {
  const distinct = tokens(serviceWorkspaceLabel(name)).filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t));
  if (distinct.length === 0) return false;
  const spoken = new Set(tokens(text));
  return distinct.every((t) => spoken.has(t));
}

type ParsedSwitch = { role: Role | null; target: string | null; rest: string } | { menu: true };

const PREFIX = /^\s*(manager|resident|admin)\s*:\s*([\s\S]*)$/i;
const AS_LEAD = /^\s*as\s+(?:a\s+|an\s+|the\s+|my\s+)?(manager|resident|admin)\b\s*[,:.\-]?\s*([\s\S]*)$/i;
const AS_TRAIL = /^([\s\S]*?)[\s,.]+as\s+(?:a\s+|an\s+)?(manager|resident|admin)\s*[.!]?\s*$/i;
const SWITCH = /^\s*(?:switch|change)\s+(?:me\s+|over\s+)?to\s+([\s\S]+)$/i;
const MENU = /^\s*(?:menu|switch|switch\s+(?:roles?|accounts?|context|workspaces?)|change\s+(?:roles?|accounts?|context))\s*[.!?]?\s*$/i;

function parseSwitch(body: string): ParsedSwitch | null {
  if (MENU.test(body)) return { menu: true };
  let m = PREFIX.exec(body);
  if (m) return { role: m[1]!.toLowerCase() as Role, target: null, rest: m[2]!.trim() };
  m = AS_LEAD.exec(body);
  if (m) return { role: m[1]!.toLowerCase() as Role, target: null, rest: m[2]!.trim() };
  m = AS_TRAIL.exec(body);
  if (m && m[1]!.trim()) return { role: m[2]!.toLowerCase() as Role, target: null, rest: m[1]!.trim() };
  m = SWITCH.exec(body);
  if (m && m[1]!.trim()) {
    const words = m[1]!.trim();
    const role = /^(?:my\s+|the\s+|a\s+)?(manager|resident|admin)\b\s*([\s\S]*)$/i.exec(words);
    // "switch to manager" is a role; "switch to admin 5259 status" keeps the rest as the question.
    if (role) return { role: role[1]!.toLowerCase() as Role, target: null, rest: role[2]!.trim() };
    return { role: null, target: words, rest: "" };
  }
  return null;
}

/** An answer to our question: a digit, a role word, or a name from the options. Null when the text is something else. */
function answerFromPending(body: string, pending: SenderPending, contexts: readonly SenderContext[]): SenderTarget | null {
  const text = body.trim();
  const digit = /^\s*(\d{1,2})\s*[.)!]?\s*$/.exec(text);
  if (digit) {
    const picked = pending.options[Number(digit[1]) - 1];
    return picked && resolveSenderTarget(contexts, picked) ? picked : null;
  }
  const role = /^\s*(?:my\s+|the\s+)?(manager|resident|admin)\s*[.!]?\s*$/i.exec(text);
  const pool = pending.options.filter((o) => resolveSenderTarget(contexts, o));
  if (role) {
    const wanted = role[1]!.toLowerCase();
    const matches = pool.filter((o) => resolveSenderTarget(contexts, o)?.context.kind === wanted);
    return matches.length === 1 ? matches[0]! : null;
  }
  const named = pool.filter((o) => {
    const resolved = resolveSenderTarget(contexts, o);
    if (!resolved) return false;
    const { context } = resolved;
    if (context.kind === "manager") return textNamesWorkspace(text, context.name);
    if (context.kind === "resident") return listingsNamedIn(text, [{ id: context.key, address: context.label, title: context.label, buildingName: "", neighborhood: "" }]).length > 0;
    return false;
  });
  return named.length === 1 ? named[0]! : null;
}

// --- naming ---------------------------------------------------------------------------------------------------------

type Named = { kind: "one"; target: SenderTarget } | { kind: "none" } | { kind: "mixed" };

/**
 * Which context does this text point at by NAME: a workspace's distinctive name, or a home it names (street number and
 * street word, a lettered number like 4709A, or the house name). Several homes of one workspace are that workspace;
 * homes across workspaces the sender staffs as admin are the admin context (the caller asks which workspace); homes in
 * different kinds of context (a home they rent AND one they run) are `mixed`, never a guess.
 */
async function named(
  text: string,
  contexts: readonly SenderContext[],
  loadHomes: () => Promise<readonly SenderHome[]>,
  allowed: ReadonlySet<string>,
): Promise<Named> {
  const hits: SenderTarget[] = [];
  const add = (t: SenderTarget) => {
    if (allowed.has(t.key) && !hits.some((h) => sameTarget(h, t))) hits.push(t);
  };
  for (const context of contexts) {
    if (context.kind === "manager" && textNamesWorkspace(text, context.name)) add({ key: context.key });
    if (context.kind === "admin") {
      for (const ws of context.workspaces) if (textNamesWorkspace(text, ws.name)) add({ key: "admin", workspaceId: ws.id });
    }
  }
  if (/\d/.test(text) || hits.length === 0) {
    const homes = await loadHomes().catch(() => [] as readonly SenderHome[]);
    const named = listingsNamedIn(text, homes);
    for (const home of named) add((home as SenderHome).target);
    // Once a text is plainly talking about addresses ("4709A 5259 5257"), a bare house number that is exactly one of
    // their homes' numbers is that home too. A bare number alone (a rent figure) never names one.
    if (named.length > 0) {
      const bare = new Set(tokens(text).filter((t) => /^\d{3,6}[a-z]?$/.test(t)));
      for (const home of homes) {
        const number = parseStreetLine(home.address)?.number;
        if (number && bare.has(number)) add(home.target);
      }
    }
  }
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", target: hits[0]! };
  if (hits.every((h) => h.key === "admin")) return { kind: "one", target: { key: "admin" } };
  return { kind: "mixed" };
}

// --- the decision ---------------------------------------------------------------------------------------------------

export async function decideSenderContext(input: SenderContextInput): Promise<SenderDecision> {
  const { contexts, body, now } = input;
  // A one-person sender is never asked and never tagged: today's behaviour, byte for byte.
  if (contexts.length < 2) return { kind: "unchanged" };
  const valid = (t: SenderTarget | null): t is SenderTarget => Boolean(t && resolveSenderTarget(contexts, t));
  const sticky = input.sticky && now - input.sticky.at <= SENDER_STICKY_TTL_MS && valid(input.sticky.target) ? input.sticky : null;
  const pending = input.pending && now - input.pending.at <= SENDER_QUESTION_TTL_MS ? input.pending : null;
  const run = (target: SenderTarget, text: string, source: Extract<SenderDecision, { kind: "run" }>["source"]): SenderDecision => ({
    kind: "run",
    target,
    body: text,
    tag: sameTarget(sticky?.target ?? null, target) ? null : senderTargetTag(contexts, target),
    source,
  });
  const ask = (held: { body: string; messageSid: string }, options = senderMenuOptions(contexts)): SenderDecision => ({
    kind: "reply",
    text: senderQuestionText(contexts, options),
    pending: { options, body: held.body, messageSid: held.messageSid },
  });

  // 1. the answer to our question
  if (pending) {
    const picked = answerFromPending(body, pending, contexts);
    if (picked) {
      if (!pending.body.trim()) {
        return { kind: "reply", text: `${senderTargetLabel(contexts, picked)}. What do you need?`, sticky: picked };
      }
      return run(picked, pending.body, "answer");
    }
  }

  // 2 + 3. the menu and explicit switch words
  const parsed = parseSwitch(body);
  if (parsed && "menu" in parsed) {
    const options = senderMenuOptions(contexts);
    return { kind: "reply", text: senderQuestionText(contexts, options), pending: { options, body: "", messageSid: input.messageSid } };
  }
  if (parsed) {
    const done = (target: SenderTarget, rest: string): SenderDecision =>
      rest ? run(target, rest, "switch") : { kind: "reply", text: `${senderTargetLabel(contexts, target)}. What do you need?`, sticky: target };
    if (parsed.role) {
      const pool = contexts.filter((c) => c.kind === parsed.role || (parsed.role === "manager" && c.kind === "admin" && !contexts.some((x) => x.kind === "manager")));
      if (pool.length === 0) {
        return { kind: "reply", text: `I do not see a ${parsed.role} account for this number. ${senderQuestionText(contexts)}`, pending: { options: senderMenuOptions(contexts), body: "", messageSid: input.messageSid } };
      }
      const poolKeys = new Set(pool.map((c) => c.key));
      const byName = parsed.rest ? await named(parsed.rest, contexts, input.loadHomes, poolKeys) : ({ kind: "none" } as Named);
      if (byName.kind === "one") return done(byName.target, parsed.rest);
      if (pool.length === 1) return done({ key: pool[0]!.key }, parsed.rest);
      const options = pool.map((c) => ({ key: c.key }));
      return ask({ body: parsed.rest, messageSid: input.messageSid }, options);
    }
    if (parsed.target) {
      const byName = await named(parsed.target, contexts, input.loadHomes, new Set(contexts.map((c) => c.key)));
      if (byName.kind === "one") return done(byName.target, "");
      // "switch off the heat in 5257": not a switch we can read, so it is an ordinary text below.
    }
  }

  // 4. a home or workspace named in the text
  const byName = await named(body, contexts, input.loadHomes, new Set(contexts.map((c) => c.key)));
  if (byName.kind === "one") return run(byName.target, body, "named");

  // 5. an explicit pick the sender made, which the number they texted does not undo
  if (sticky?.explicitAt !== undefined && now - sticky.explicitAt <= SENDER_STICKY_TTL_MS) return run(sticky.target, body, "sticky");

  // 6. the work number they texted, when it is a workspace's own
  if (valid(input.numberDefault)) return run(input.numberDefault, body, "number");

  // 7. a reply to a text we sent about one workspace, newer than the last pick
  const notice = await input.loadNotice().catch(() => null);
  if (notice && now - notice.at <= SENDER_STICKY_TTL_MS && (!sticky || notice.at > sticky.at)) {
    const targets: SenderTarget[] = [];
    for (const c of contexts) {
      if ((c.kind === "manager" || c.kind === "resident") && c.workspaceId === notice.workspaceId) targets.push({ key: c.key });
      if (c.kind === "admin" && c.workspaces.some((w) => w.id === notice.workspaceId)) targets.push({ key: "admin", workspaceId: notice.workspaceId });
    }
    // One workspace that is also a home they rent is not a notice we can place: fall through.
    if (targets.length === 1) return run(targets[0]!, body, "notice");
  }

  // 8. the last pick we inferred
  if (sticky) return run(sticky.target, body, "sticky");

  // 9. one question; the text waits
  return ask({ body, messageSid: input.messageSid });
}
