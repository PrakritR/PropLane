"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatVendorQuoteSmsChallengeMessage, type VendorQuotePublicProjection, type VendorQuoteResponseInput, type VendorQuoteWindow } from "@/lib/vendor-quote-contract";

type Purpose = "response" | "withdrawal";
type ExchangeBody = { ok: true; projection: VendorQuotePublicProjection } | { ok: false };
type ApiResult = { error?: string; ok?: boolean; purpose?: Purpose; code?: string; message?: string; projection?: VendorQuotePublicProjection; followUpReply?: string | null; challenge?: { code: string; destinationPhone: string; expiresAt: string } };
type QuoteField = "laborCents" | "materialsCents" | "diagnosticFeeCents";
type WindowDraft = { start: string; end: string };
const SESSION_BINDING_STORAGE_KEY = "proplane:vendor-quote-session-binding";

const fieldClass = "min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";
const labelClass = "block space-y-1.5 text-sm font-medium text-foreground";

function dollarsToCents(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(trimmed)) return "invalid";
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents <= 1_000_000_000 ? cents : "invalid";
}

function centsToDollars(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "";
  return (value / 100).toFixed(2);
}

function responseNeedsFollowUp(response: VendorQuoteResponseInput): boolean {
  return Boolean(
    response.question.trim() ||
    response.diagnosticFeeCents === null ||
    (response.laborCents === null && response.diagnosticFeeCents === null) ||
    (response.materialsCents === null && response.laborCents !== null) ||
    !response.scope.trim() ||
    response.durationMinutes === null ||
    response.windows.length === 0
  );
}

function isoToLocalInput(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseWindow(draft: WindowDraft): VendorQuoteWindow | null | "invalid" {
  if (!draft.start && !draft.end) return null;
  if (!draft.start || !draft.end) return "invalid";
  const start = new Date(draft.start);
  const end = new Date(draft.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) return "invalid";
  return { startIso: start.toISOString(), endIso: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}

function initialDraft(projection: VendorQuotePublicProjection | null) {
  const quote = projection?.quote;
  return {
    amounts: {
      laborCents: centsToDollars(quote?.laborCents),
      materialsCents: centsToDollars(quote?.materialsCents),
      diagnosticFeeCents: centsToDollars(quote?.diagnosticFeeCents),
    } satisfies Record<QuoteField, string>,
    scope: quote?.scope ?? "",
    exclusions: quote?.exclusions ?? "",
    duration: quote?.durationMinutes ? String(quote.durationMinutes) : "",
    windows: (projection?.windows ?? []).map((window) => ({ start: isoToLocalInput(window.startIso), end: isoToLocalInput(window.endIso) })),
  };
}

function getFragment(): { token: string; purpose: Purpose } | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  const stop = raw.startsWith("stop=");
  let token = "";
  try { token = decodeURIComponent(stop ? raw.slice(5) : raw).trim(); } catch { return null; }
  return token ? { token, purpose: stop ? "withdrawal" : "response" } : null;
}

async function readApiResult(response: Response): Promise<ApiResult> {
  return await response.json().catch(() => ({})) as ApiResult;
}

function readStoredSessionBinding(): { ok: boolean; binding: string | null } {
  try {
    return { ok: true, binding: window.sessionStorage.getItem(SESSION_BINDING_STORAGE_KEY) };
  } catch {
    return { ok: false, binding: null };
  }
}

function storeSessionBinding(binding: string | undefined): boolean {
  if (!binding) return false;
  try {
    window.sessionStorage.setItem(SESSION_BINDING_STORAGE_KEY, binding);
    return true;
  } catch {
    return false;
  }
}

export function VendorQuotePublicPage() {
  const [projection, setProjection] = useState<VendorQuotePublicProjection | null>(null);
  const [purpose, setPurpose] = useState<Purpose>("response");
  const [screen, setScreen] = useState<"loading" | "ready" | "unavailable" | "declined" | "stopped">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [followUpReply, setFollowUpReply] = useState<string | null>(null);
  const [responseSaved, setResponseSaved] = useState(false);
  const [followUpPending, setFollowUpPending] = useState(false);
  const [draft, setDraft] = useState(() => initialDraft(null));
  const [smsConsent, setSmsConsent] = useState(false);
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<{ code: string; destinationPhone: string; expiresAt: string } | null>(null);
  const [challengeCopied, setChallengeCopied] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const csrfHeaders = useMemo(() => ({ "Content-Type": "application/json" }), []);

  const loadFromCookie = useCallback(async () => {
    const response = await fetch("/api/public/vendor-quote/session", { cache: "no-store", credentials: "same-origin" });
    const body = await readApiResult(response);
    if (!response.ok || !body.ok || !body.projection) {
      setScreen("unavailable");
      return;
    }
    const storedBinding = readStoredSessionBinding();
    if (!storedBinding.ok || !body.projection.sessionBinding ||
        storedBinding.binding && storedBinding.binding !== body.projection.sessionBinding ||
        !storeSessionBinding(body.projection.sessionBinding)) {
      setScreen("unavailable");
      return;
    }
    setProjection(body.projection);
    setDraft(initialDraft(body.projection));
    setFollowUpReply(body.projection.followUpReply ?? null);
    setPurpose(body.purpose === "withdrawal" ? "withdrawal" : "response");
    setScreen("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const rawHash = window.location.hash;
    const fragment = getFragment();
    if (rawHash && !fragment) {
      window.history.replaceState(null, "", window.location.pathname);
      queueMicrotask(() => { if (!cancelled) setScreen("unavailable"); });
      return () => { cancelled = true; };
    }
    if (fragment) {
      window.history.replaceState(null, "", window.location.pathname);
      void (async () => {
        const response = await fetch("/api/public/vendor-quote/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify(fragment),
        });
        const body = await readApiResult(response) as ExchangeBody;
        if (cancelled) return;
        if (!response.ok || !body.ok || !body.projection) {
          setScreen("unavailable");
          return;
        }
        if (!storeSessionBinding(body.projection.sessionBinding)) {
          setScreen("unavailable");
          return;
        }
        setPurpose(fragment.purpose);
        setProjection(body.projection);
        setDraft(initialDraft(body.projection));
        setFollowUpReply(body.projection.followUpReply ?? null);
        setScreen("ready");
      })().catch(() => { if (!cancelled) setScreen("unavailable"); });
    } else {
      queueMicrotask(() => {
        if (!cancelled) void loadFromCookie().catch(() => { if (!cancelled) setScreen("unavailable"); });
      });
    }
    return () => { cancelled = true; };
  }, [loadFromCookie]);

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/vendor-quote/${path}`, {
        method: "POST",
        headers: {
          ...csrfHeaders,
          ...(projection?.sessionBinding ? { "X-Vendor-Quote-Binding": projection.sessionBinding } : {}),
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const result = await readApiResult(response);
      if (!response.ok || !result.ok) {
        setError(response.status === 409 && typeof result.error === "string" ? result.error : "This link is no longer available. Reopen the latest quote email or contact the sender.");
        return null;
      }
      if (result.projection) setProjection(result.projection);
      return result;
    } catch {
      setError("Your response could not be saved. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [csrfHeaders, projection]);

  const submitResponse = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projection) return;
    const amounts = Object.fromEntries(Object.entries(draft.amounts).map(([key, value]) => [key, dollarsToCents(value)])) as Record<QuoteField, number | null | "invalid">;
    const invalidAmount = Object.values(amounts).some((value) => value === "invalid");
    const duration = draft.duration.trim() ? Number(draft.duration) : null;
    const windows = draft.windows.map(parseWindow);
    if (invalidAmount) { setError("Enter amounts in dollars and cents, such as 125.00."); return; }
    if (draft.duration && (!Number.isInteger(duration) || duration! < 15 || duration! > 480)) { setError("Duration must be a whole number of minutes from 15 to 480."); return; }
    if (windows.some((window) => window === "invalid")) { setError("Each availability window needs a valid start and end, with the end after the start."); return; }
    const validWindows = windows.filter((window): window is VendorQuoteWindow => window !== null && window !== "invalid");
    if (amounts.laborCents === null && amounts.materialsCents === null && amounts.diagnosticFeeCents === null &&
        !draft.scope.trim() && !draft.exclusions.trim() && duration === null && validWindows.length === 0 && !question.trim()) {
      setError("Add a quote detail, availability window, or question before sending.");
      return;
    }
    const response: VendorQuoteResponseInput = {
      laborCents: amounts.laborCents as number | null,
      materialsCents: amounts.materialsCents as number | null,
      diagnosticFeeCents: amounts.diagnosticFeeCents as number | null,
      scope: draft.scope.trim(),
      exclusions: draft.exclusions.trim(),
      durationMinutes: duration,
      windows: validWindows,
      question: question.trim(),
    };
    const result = await post("response", { action: "submit", expectedVersion: projection.currentVersion, response });
    if (result) {
      const latestProjection = result.projection ?? projection;
      setProjection(latestProjection);
      setDraft(initialDraft(latestProjection));
      setQuestion("");
      const reply = result.followUpReply ?? latestProjection.followUpReply ?? null;
      setFollowUpReply(reply);
      setFollowUpPending(responseNeedsFollowUp(response) && !reply);
      setResponseSaved(true);
    }
  };

  const decline = async () => {
    if (!projection) return;
    const result = await post("response", { action: "decline", expectedVersion: projection.currentVersion });
    if (result) setScreen("declined");
  };

  const stopEmail = async () => {
    const result = await post("withdrawal", { action: "stop_email" });
    if (result) setScreen("stopped");
  };

  const requestSmsChallenge = async () => {
    setSmsError(null);
    if (!smsConsent) { setSmsError("Choose text consent first, or send your quote by email only."); return; }
    if (!/^\+[1-9]\d{7,14}$/.test(phone.trim())) { setSmsError("Enter a mobile number in international format, such as +14155550123."); return; }
    const result = await post("sms-challenge", { phoneE164: phone.trim(), consented: true });
    if (result?.challenge) { setChallenge(result.challenge); setChallengeCopied(false); }
    else setSmsError("The text challenge could not be created. Try again or send your quote by email only.");
  };

  const copySmsChallenge = async () => {
    if (!challenge) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(formatVendorQuoteSmsChallengeMessage(challenge.code));
      setChallengeCopied(true);
      setSmsError(null);
    } catch {
      setChallengeCopied(false);
      setSmsError("The message could not be copied. Select and copy it instead.");
    }
  };

  const updateAmount = (key: QuoteField, value: string) => setDraft((current) => ({ ...current, amounts: { ...current.amounts, [key]: value } }));
  const unavailableText = purpose === "withdrawal" ? "This stop link is no longer available." : "This quote link is no longer available.";

  if (screen === "loading") return <div className="mx-auto min-h-[55vh] max-w-2xl px-4 py-12 sm:px-6" aria-busy="true"><div className="glass-card space-y-5 rounded-3xl p-6 sm:p-10"><div className="h-7 w-56 animate-pulse motion-reduce:animate-none rounded bg-muted" /><div className="h-4 w-full animate-pulse motion-reduce:animate-none rounded bg-muted" /><div className="h-11 w-full animate-pulse motion-reduce:animate-none rounded-xl bg-muted" /></div></div>;
  if (screen === "unavailable") return <main className="mx-auto min-h-[55vh] max-w-2xl px-4 py-12 sm:px-6"><section className="glass-card rounded-3xl p-6 sm:p-10"><h1 className="text-2xl font-semibold tracking-tight text-foreground">{unavailableText}</h1><p className="mt-4 text-sm text-muted-foreground">Open the most recent message from the sender.</p></section></main>;
  if (screen === "declined" || screen === "stopped") {
    const title = screen === "declined" ? "You declined this request." : "Quote emails have stopped.";
    return <main className="mx-auto min-h-[55vh] max-w-2xl px-4 py-12 sm:px-6"><section className="glass-card rounded-3xl p-6 sm:p-10"><h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1></section></main>;
  }
  if (!projection) return null;

  return (
    <main className="mx-auto min-h-[55vh] w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <article className="glass-card rounded-3xl p-5 sm:p-9">
        <header className="border-b border-border pb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Service quote</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{purpose === "withdrawal" ? "Email preferences" : "Respond to a service request"}</h1>
          <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">From</dt><dd className="font-medium text-foreground">{projection.senderName}</dd></div>
            <div><dt className="text-muted-foreground">Contact</dt><dd className="font-medium text-foreground"><a className="underline decoration-primary/50 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" href={`mailto:${projection.senderEmail}`}>{projection.senderEmail}</a></dd></div>
            <div><dt className="text-muted-foreground">Reference</dt><dd className="font-medium text-foreground">{projection.reference}</dd></div>
            <div><dt className="text-muted-foreground">Service</dt><dd className="font-medium text-foreground">{projection.category}</dd></div>
            <div><dt className="text-muted-foreground">City</dt><dd className="font-medium text-foreground">{projection.city}</dd></div>
          </dl>
          <dl className="mt-5"><div><dt className="text-muted-foreground">Problem</dt><dd className="font-medium text-foreground">{projection.problemDescription ?? "Not specified"}</dd></div></dl>
          <p className="mt-4 text-xs text-muted-foreground">Request closes {new Date(projection.expiresAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</p>
        </header>

        {purpose === "withdrawal" ? (
          <section className="pt-6">
            <h2 className="text-lg font-semibold text-foreground">Stop emails about this quote?</h2>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button type="button" disabled={busy || !projection.canStopEmail} aria-busy={busy} onClick={stopEmail}>Stop quote emails</Button>
            </div>
            {error ? <p role="alert" className="mt-4 text-sm text-danger">{error}</p> : null}
          </section>
        ) : (
          <>
            <form className="space-y-7 pt-6" onSubmit={submitResponse} aria-busy={busy}>
              {responseSaved ? <div role="status" className="rounded-2xl border border-border bg-card p-4 text-sm text-foreground">
                <p className="font-medium">Your response is saved.</p>
                {followUpReply ? <div className="mt-3"><h2 className="font-semibold">Reply from the sender</h2><p className="mt-1 whitespace-pre-wrap">{followUpReply}</p></div> : null}
                {followUpPending ? <p className="mt-2">Your message is saved for the sender to follow up. No automated reply was available.</p> : null}
              </div> : null}
              <fieldset className="space-y-4">
                <legend className="text-lg font-semibold text-foreground">Your quote</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  {([ ["laborCents", "Labor amount"], ["materialsCents", "Materials amount"], ["diagnosticFeeCents", "Diagnostic fee"] ] as const).map(([key, label]) => (
                    <label className={labelClass} key={key}>{label} (USD)<input className={fieldClass} type="text" inputMode="decimal" autoComplete="off" value={draft.amounts[key]} onChange={(event) => updateAmount(key, event.target.value)} placeholder="125.00" /></label>
                  ))}
                </div>
                <label className={labelClass}>Scope<textarea className={fieldClass} rows={3} maxLength={4000} value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} /></label>
                <label className={labelClass}>Exclusions<textarea className={fieldClass} rows={2} maxLength={4000} value={draft.exclusions} onChange={(event) => setDraft((current) => ({ ...current, exclusions: event.target.value }))} /></label>
                <label className={labelClass}>Estimated duration in minutes<input className={fieldClass} type="text" inputMode="numeric" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: event.target.value.replace(/[^0-9]/g, "") }))} placeholder="90" /></label>
              </fieldset>

              <fieldset className="space-y-4">
                <legend className="text-lg font-semibold text-foreground">Availability - {Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}</legend>
                {draft.windows.map((window, index) => (
                  <div className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" key={`window-${index}`}>
                    <label className={labelClass}>Start<input className={fieldClass} type="datetime-local" value={window.start} onChange={(event) => setDraft((current) => ({ ...current, windows: current.windows.map((item, itemIndex) => itemIndex === index ? { ...item, start: event.target.value } : item) }))} /></label>
                    <label className={labelClass}>End<input className={fieldClass} type="datetime-local" value={window.end} onChange={(event) => setDraft((current) => ({ ...current, windows: current.windows.map((item, itemIndex) => itemIndex === index ? { ...item, end: event.target.value } : item) }))} /></label>
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => setDraft((current) => ({ ...current, windows: current.windows.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" disabled={busy || draft.windows.length >= 8} onClick={() => setDraft((current) => ({ ...current, windows: [...current.windows, { start: "", end: "" }] }))}>Add availability window</Button>
              </fieldset>

              <label className={labelClass}>Question for the sender<textarea className={fieldClass} rows={3} maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
              {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Sending response…" : "Send response"}</Button>
                <Button type="button" variant="secondary" disabled={busy} aria-busy={busy} onClick={decline}>Decline request</Button>
              </div>
            </form>

            <section className="mt-9 border-t border-border pt-6">
              <h2 className="text-lg font-semibold text-foreground">Optional text updates</h2>
              <label className="mt-4 flex min-h-11 items-start gap-3 text-sm text-foreground">
                <input className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" type="checkbox" checked={smsConsent} onChange={(event) => { setSmsConsent(event.target.checked); setChallenge(null); }} />
                <span>I agree to receive text messages from {projection.senderName} about this quote request. Consent is optional. Message frequency varies. Message and data rates may apply. Reply STOP to stop.</span>
              </label>
              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className={labelClass}>Mobile number<input className={fieldClass} type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+14155550123" /></label>
                <Button type="button" variant="secondary" disabled={busy || !smsConsent} aria-busy={busy} onClick={requestSmsChallenge}>Create SMS challenge</Button>
              </div>
              {smsError ? <p role="alert" className="mt-3 text-sm text-danger">{smsError}</p> : null}
              {challenge ? <div className="mt-4 rounded-2xl border border-border p-4"><p className="text-sm font-medium text-foreground">Text this message to {challenge.destinationPhone}</p><p className="mt-2 font-mono text-xl font-semibold tracking-widest text-foreground"><code aria-label="SMS verification message">{formatVendorQuoteSmsChallengeMessage(challenge.code)}</code></p><Button className="mt-3" type="button" variant="secondary" onClick={copySmsChallenge}>{challengeCopied ? "Copied" : "Copy text"}</Button><p className="mt-2 text-sm text-muted-foreground">Expires {new Date(challenge.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p></div> : null}
              {projection.smsConsent === "granted" ? <p className="mt-4 text-sm text-foreground">Text updates are enabled for this quote.</p> : null}
              {projection.smsConsent === "pending" ? <p className="mt-4 text-sm text-foreground" role="status">Text verification is pending. You can still send your quote by email only.</p> : null}
            </section>

          </>
        )}
      </article>
    </main>
  );
}
