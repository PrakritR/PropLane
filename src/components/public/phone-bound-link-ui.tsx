"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { renterSmsHref } from "@/components/public-site/journey-paths";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import "./phone-bound-link-ui.css";

/**
 * The public pages behind a phone-bound link (`/l/<token>`) and the public phone-bind doors
 * (`/apply/<code>`, `/tour/<code>`). A heading and one card with its control; none of it says what
 * the link is for before the code is entered.
 */

/** The centered column every door sits in. `size` picks the heading: the big one for a door's name, the small one for a gate. */
export function DoorShell({
  title,
  children,
  dataAttr,
  size = "h2",
}: {
  title: string;
  children: ReactNode;
  dataAttr: string;
  size?: "h1" | "h2";
}) {
  return (
    <div className="ps ps-narrow ps-page ps-door" data-attr={dataAttr}>
      <h1 className={`${size === "h1" ? "ps-h1" : "ps-h2"} ps-door-title`}>{title}</h1>
      <div className="ps-card ps-door-card">{children}</div>
    </div>
  );
}

/** A button that stays disabled while its (async) action runs, so a double tap never sends two codes. */
export function DoorButton({
  children,
  onClick,
  disabled = false,
  dataAttr,
  tone = "blue",
}: {
  children: ReactNode;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  dataAttr: string;
  tone?: "blue" | "text";
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClick();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={tone === "blue" ? "ps-btn ps-btn-blue" : "ps-text-btn"}
      disabled={disabled || busy}
      data-attr={dataAttr}
      onClick={run}
    >
      {children}
    </button>
  );
}

/** One view for a dead, unknown, used or mismatched link. It says nothing about why. */
export function LinkExpiredView() {
  const { phone } = usePublicTexting();
  const smsHref = renterSmsHref(phone);
  return (
    <div className="ps ps-narrow ps-page ps-door" data-attr="phone-link-expired">
      <h1 className="ps-h2 ps-door-title-sm ps-door-title">This link has expired</h1>
      <p className="ps-door-line">
        {smsHref ? (
          <>
            Text{" "}
            <a className="ps-link" href={smsHref} data-attr="phone-link-expired-text">
              {formatUsPhoneDisplay(phone)}
            </a>{" "}
            for a new one.
          </>
        ) : (
          "Ask for a new link."
        )}
      </p>
      <div className="ps-door-actions">
        <Link href="/rent/browse" className="ps-btn ps-btn-line" data-attr="phone-link-expired-browse">
          Find a home
        </Link>
      </div>
    </div>
  );
}

export function LinkMessageView({ title, line }: { title: string; line?: string }) {
  return (
    <div className="ps ps-narrow ps-page ps-door" data-attr="phone-link-message">
      <h1 className="ps-h2 ps-door-title">{title}</h1>
      {line ? <p className="ps-door-line">{line}</p> : null}
    </div>
  );
}

type Step = "ask" | "code";

export function CodeInput({
  value,
  onChange,
  onEnter,
  dataAttr = "phone-link-code-input",
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  dataAttr?: string;
}) {
  return (
    <input
      className="ps-input ps-code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      placeholder="6-digit code"
      aria-label="Code"
      data-attr={dataAttr}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
      onKeyDown={(event) => {
        if (event.key === "Enter") onEnter();
      }}
    />
  );
}

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, error: typeof data.error === "string" ? data.error : undefined, data };
  } catch {
    return { ok: false, error: "Could not reach PropLane. Check your connection.", data: {} };
  }
}

/** The code step of a protected link. The code is texted to the number the link was sent to. */
export function LinkCodeGate({ token }: { token: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("ask");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/l/${encodeURIComponent(token)}/code`;

  const send = async () => {
    setError("");
    const result = await post(endpoint, { action: "send" });
    if (result.ok) {
      setStep("code");
      setCode("");
    } else setError(result.error ?? "Could not send a code.");
  };
  const verify = async () => {
    setError("");
    const result = await post(endpoint, { action: "verify", code });
    if (result.ok) router.refresh();
    else setError(result.error ?? "That code did not work.");
  };

  return (
    <DoorShell title="Confirm it's you" dataAttr="phone-link-gate">
      {step === "ask" ? (
        <DoorButton dataAttr="phone-link-send-code" onClick={send}>
          Text me a code
        </DoorButton>
      ) : (
        <>
          <CodeInput value={code} onChange={setCode} onEnter={verify} />
          <DoorButton disabled={code.length !== 6} dataAttr="phone-link-verify" onClick={verify}>
            Verify
          </DoorButton>
          <DoorButton tone="text" dataAttr="phone-link-resend" onClick={send}>
            Send a new code
          </DoorButton>
        </>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="phone-link-error">
          {error}
        </p>
      ) : null}
    </DoorShell>
  );
}

export type RentLinkCharge = { id: string; title: string; amountLabel: string; propertyLabel: string };

/** "$1,200.00" -> 120000 cents, or null when a label is not a plain dollar amount. */
function labelCents(label: string): number | null {
  const match = /^\$\s*([\d,]+(?:\.\d{1,2})?)$/.exec(label.trim());
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** The sum of the charges' own labels, shown only when every label is a plain dollar amount. Display only: checkout re-reads the live rows. */
function totalLabel(charges: RentLinkCharge[]): string | null {
  const cents = charges.map((charge) => labelCents(charge.amountLabel));
  if (cents.length === 0 || cents.some((value) => value === null)) return null;
  const sum = cents.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(sum / 100);
}

/** Pay the charge(s) a rent link names, by card. The amount comes from the live charge, never the page. */
export function RentLinkCard({ token, charges }: { token: string; charges: RentLinkCharge[] }) {
  const [error, setError] = useState("");
  const [signInHref, setSignInHref] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [paid, setPaid] = useState(false);
  const total = totalLabel(charges);

  const pay = async () => {
    setError("");
    const result = await post(`/api/l/${encodeURIComponent(token)}/rent-checkout`, {});
    const secret = typeof result.data.clientSecret === "string" ? result.data.clientSecret : "";
    // The payment form opens right here on the page: card, Apple Pay or Google Pay. No other site is opened.
    if (result.ok && secret) {
      setClientSecret(secret);
      return;
    }
    if (result.data.needsCode) {
      window.location.reload();
      return;
    }
    setError(result.error ?? "Checkout could not start.");
    if (typeof result.data.signInHref === "string") setSignInHref(result.data.signInHref);
  };

  if (paid) return <LinkMessageView title="Payment received" line="You can close this page." />;

  return (
    <DoorShell title="Pay" dataAttr="phone-link-rent">
      <ul className="ps-facts" data-attr="phone-link-rent-charges">
        {charges.map((charge) => (
          <li key={charge.id}>
            <span className="ps-facts-title">
              {charge.title}
              {charge.propertyLabel ? <span className="ps-mute"> · {charge.propertyLabel}</span> : null}
            </span>
            <span>{charge.amountLabel}</span>
          </li>
        ))}
      </ul>
      {total ? (
        <div className="ps-door-total" data-attr="phone-link-rent-total">
          <span>Total</span>
          <span className="ps-figure">{total}</span>
        </div>
      ) : null}
      {clientSecret ? (
        <div data-attr="phone-link-payment-form">
          <StripeEmbeddedCheckout clientSecret={clientSecret} onComplete={() => setPaid(true)} />
        </div>
      ) : (
        <DoorButton dataAttr="phone-link-pay" onClick={pay}>
          {total ? `Pay ${total}` : "Pay"}
        </DoorButton>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="phone-link-error">
          {error}
        </p>
      ) : null}
      {signInHref ? (
        <a className="ps-btn ps-btn-line" href={signInHref}>
          Sign in to PropLane
        </a>
      ) : null}
    </DoorShell>
  );
}

/** `/apply/<code>` and `/tour/<code>`: a phone, a code by text, then straight into the flow. */
export function PublicPhoneBindForm({ code, kind, heading }: { code: string; kind: "apply" | "tour"; heading: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("ask");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");

  const send = async () => {
    setError("");
    const result = await post("/api/public/phone-bind", { code, kind, action: "send", phone });
    if (result.ok) {
      setStep("code");
      setOtp("");
    } else setError(result.error ?? "Could not send a code.");
  };
  const verify = async () => {
    setError("");
    const result = await post("/api/public/phone-bind", { code, kind, action: "verify", phone, otp });
    const href = typeof result.data.href === "string" ? result.data.href : "";
    if (result.ok && href.startsWith("/l/")) router.push(href);
    else setError(result.error ?? "That code did not work.");
  };

  return (
    <DoorShell title={heading} dataAttr={`phone-bind-${kind}`} size="h1">
      {step === "ask" ? (
        <>
          <PhoneNumberField
            value={phone}
            onChange={setPhone}
            name="phone"
            placeholder="Mobile number"
            dataAttr="phone-bind-phone"
          />
          <DoorButton disabled={!phone} dataAttr="phone-bind-send" onClick={send}>
            Text me a code
          </DoorButton>
        </>
      ) : (
        <>
          <CodeInput value={otp} onChange={setOtp} onEnter={verify} dataAttr="phone-bind-code-input" />
          <DoorButton disabled={otp.length !== 6} dataAttr="phone-bind-verify" onClick={verify}>
            Verify
          </DoorButton>
          <DoorButton tone="text" dataAttr="phone-bind-resend" onClick={send}>
            Send a new code
          </DoorButton>
        </>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="phone-bind-error">
          {error}
        </p>
      ) : null}
    </DoorShell>
  );
}
