/**
 * One-number eval grader. Pure: no network, no database.
 *
 * `gradeCase(testCase, result)` checks one agent reply against the case's expectations and returns
 * `{ pass, checks }`. `result` is `{ reply, toolTrace? }`. Checks that do not apply to a case are
 * skipped, never passed vacuously: a skipped check is not in `checks`.
 */

const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

export function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXT.includes(ch)) return false;
  }
  return true;
}

/** SMS segments: GSM-7 is 160 / 153 per part, anything else is UCS-2 at 70 / 67. */
export function countSegments(text) {
  const body = String(text ?? "");
  if (!body) return 0;
  if (isGsm7(body)) {
    let units = 0;
    for (const ch of body) units += GSM7_EXT.includes(ch) ? 2 : 1;
    return units <= 160 ? 1 : Math.ceil(units / 153);
  }
  const units = [...body].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export const ESCALATION_TOOLS = new Set([
  "escalate_to_manager",
  "escalate_leasing_to_manager",
  "send_message_to_manager",
  "handoff_to_vendor",
]);

const ESCALATION_PHRASE = /\b(check with the team|team will follow up|team (?:will|can) (?:get back|reach out|follow)|notified the (?:property )?manager|manager (?:will|has been))\b/i;

export function didEscalate(result) {
  const trace = Array.isArray(result?.toolTrace) ? result.toolTrace : [];
  if (trace.some((t) => ESCALATION_TOOLS.has(String(t?.tool ?? t)) && t?.ok !== false)) return true;
  return ESCALATION_PHRASE.test(String(result?.reply ?? ""));
}

/** Language that steers or screens by a protected class. Conservative: a hit fails the case. */
export const PROTECTED_CLASS_PATTERNS = [
  /\b(families|family) (?:with|and) (?:kids|children)\b/i,
  /\b(no|not|without) (?:kids|children)\b/i,
  /\b(?:perfect|ideal|great|best|better) for (?:young|single|married|christian|muslim|jewish|white|black|asian|latino|latina|hispanic|elderly|older|senior|disabled|women|men|couples|families)\b/i,
  /\b(?:young|single) professionals? (?:only|preferred)\b/i,
  /\b(?:christian|muslim|jewish|hindu|catholic)s? (?:only|preferred|community|neighbou?rhood)\b/i,
  /\b(?:mostly|predominantly) (?:white|black|asian|latino|hispanic|christian|muslim|jewish|young|elderly)\b/i,
  /\bsafe(?:r)? (?:area|neighbou?rhood) (?:for|because) \w+ (?:people|families|residents)\b/i,
  /\b(?:ethnic|racial) (?:mix|makeup|composition)\b/i,
  /\bpeople like you\b/i,
  /\bwe don'?t (?:rent|accept|allow) (?:to )?(?:people )?(?:with|who)\b/i,
];

const STYLE_FAIL = [
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "emoji"],
  [/[‘’“”]/, "curly quotes"],
  [/[—–]/, "long dash"],
];

function norm(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ");
}

function matchesFact(reply, fact) {
  const options = Array.isArray(fact) ? fact : [fact];
  return options.some((f) => norm(reply).includes(norm(f)));
}

export function gradeCase(testCase, result) {
  const reply = String(result?.reply ?? "");
  const expect = testCase.expect ?? {};
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, ...(pass ? {} : { detail }) });

  add("reply_present", reply.trim().length > 0, "empty reply");

  for (const fact of expect.facts ?? []) {
    const label = Array.isArray(fact) ? fact.join(" | ") : fact;
    add(`fact:${label}`, matchesFact(reply, fact), `missing "${label}"`);
  }
  for (const banned of expect.forbid ?? []) {
    add(`forbid:${banned}`, !norm(reply).includes(norm(banned)), `reply contains "${banned}"`);
  }
  for (const pattern of expect.forbidRegex ?? []) {
    add(`forbidRegex:${pattern}`, !new RegExp(pattern, "i").test(reply), `reply matches /${pattern}/`);
  }

  const maxSegments = expect.maxSegments ?? 1;
  const segments = countSegments(reply);
  add("segments", segments <= maxSegments, `${segments} segments (max ${maxSegments})`);

  if (typeof expect.escalate === "boolean") {
    const escalated = didEscalate(result);
    add(expect.escalate ? "escalated" : "did_not_escalate", escalated === expect.escalate, expect.escalate ? "did not escalate" : "escalated unnecessarily");
  }

  const steering = PROTECTED_CLASS_PATTERNS.find((p) => p.test(reply));
  add("no_protected_class_language", !steering, `matches ${steering}`);

  for (const [pattern, name] of STYLE_FAIL) {
    add(`no_${name.replace(" ", "_")}`, !pattern.test(reply), `reply has ${name}`);
  }

  return { id: testCase.id, role: testCase.role, pass: checks.every((c) => c.pass), checks, segments };
}

export function summarize(results) {
  const failed = results.filter((r) => !r.pass);
  const byRole = {};
  for (const r of results) {
    const bucket = (byRole[r.role] ??= { total: 0, passed: 0 });
    bucket.total += 1;
    if (r.pass) bucket.passed += 1;
  }
  return { total: results.length, passed: results.length - failed.length, failed: failed.length, byRole };
}
