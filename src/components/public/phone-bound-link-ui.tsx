"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";

/**
 * The public pages behind a phone-bound link (`/l/<token>`) and the public phone-bind doors
 * (`/apply/<code>`, `/tour/<code>`). A card with a heading and its control; none of it says what
 * the link is for before the code is entered.
 */

function Shell({ title, children, dataAttr }: { title: string; children: ReactNode; dataAttr: string }) {
  return (
    <div className="mx-auto flex min-h-[55vh] w-full max-w-[460px] flex-col justify-center px-4 py-12" data-attr={dataAttr}>
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <div className="mt-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/** One view for a dead, unknown, used or mismatched link. It says nothing else. */
export function LinkExpiredView() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center" data-attr="phone-link-expired">
      <h1 className="text-xl font-semibold text-foreground">This link has expired</h1>
    </div>
  );
}

export function LinkMessageView({ title }: { title: string }) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center px-6 py-16 text-center" data-attr="phone-link-message">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
    </div>
  );
}

type Step = "ask" | "code";

function CodeInput({ value, onChange, onEnter }: { value: string; onChange: (value: string) => void; onEnter: () => void }) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      placeholder="6-digit code"
      aria-label="Code"
      data-attr="phone-link-code-input"
      className="text-center text-lg tracking-[0.35em]"
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
    <Shell title="Confirm it is you" dataAttr="phone-link-gate">
      {step === "ask" ? (
        <Button type="button" className="w-full rounded-full" data-attr="phone-link-send-code" onClick={send}>
          Text me a code
        </Button>
      ) : (
        <>
          <CodeInput value={code} onChange={setCode} onEnter={verify} />
          <Button type="button" className="w-full rounded-full" disabled={code.length !== 6} data-attr="phone-link-verify" onClick={verify}>
            Continue
          </Button>
          <Button type="button" variant="ghost" className="w-full rounded-full" data-attr="phone-link-resend" onClick={send}>
            Text a new code
          </Button>
        </>
      )}
      {error ? (
        <p className="text-sm text-danger" role="alert" data-attr="phone-link-error">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}

export type RentLinkCharge = { id: string; title: string; amountLabel: string; propertyLabel: string };

/** Pay the charge(s) a rent link names, by card. The amount comes from the live charge, never the page. */
export function RentLinkCard({ token, charges }: { token: string; charges: RentLinkCharge[] }) {
  const [error, setError] = useState("");
  const [signInHref, setSignInHref] = useState("");

  const pay = async () => {
    setError("");
    const result = await post(`/api/l/${encodeURIComponent(token)}/rent-checkout`, {});
    const url = typeof result.data.url === "string" ? result.data.url : "";
    if (result.ok && url) {
      window.location.assign(url);
      return new Promise<void>(() => undefined);
    }
    if (result.data.needsCode) {
      window.location.reload();
      return;
    }
    setError(result.error ?? "Checkout could not start.");
    if (typeof result.data.signInHref === "string") setSignInHref(result.data.signInHref);
  };

  return (
    <Shell title="Pay rent" dataAttr="phone-link-rent">
      <ul className="flex flex-col divide-y divide-border" data-attr="phone-link-rent-charges">
        {charges.map((charge) => (
          <li key={charge.id} className="flex items-baseline justify-between gap-4 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium text-foreground">{charge.title}</span>
              {charge.propertyLabel ? <span className="block truncate text-sm text-muted">{charge.propertyLabel}</span> : null}
            </span>
            <span className="shrink-0 text-[15px] font-semibold text-foreground">{charge.amountLabel}</span>
          </li>
        ))}
      </ul>
      <Button type="button" className="w-full rounded-full" data-attr="phone-link-pay" onClick={pay}>
        Pay
      </Button>
      {error ? (
        <p className="text-sm text-danger" role="alert" data-attr="phone-link-error">
          {error}
        </p>
      ) : null}
      {signInHref ? (
        <Button asChild variant="outline" className="w-full rounded-full">
          <a href={signInHref}>Sign in to PropLane</a>
        </Button>
      ) : null}
    </Shell>
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
    <Shell title={heading} dataAttr={`phone-bind-${kind}`}>
      {step === "ask" ? (
        <>
          <PhoneNumberField
            value={phone}
            onChange={setPhone}
            name="phone"
            placeholder="Mobile number"
            dataAttr="phone-bind-phone"
          />
          <Button type="button" className="w-full rounded-full" disabled={!phone} data-attr="phone-bind-send" onClick={send}>
            Text me a code
          </Button>
        </>
      ) : (
        <>
          <CodeInput value={otp} onChange={setOtp} onEnter={verify} />
          <Button type="button" className="w-full rounded-full" disabled={otp.length !== 6} data-attr="phone-bind-verify" onClick={verify}>
            Continue
          </Button>
          <Button type="button" variant="ghost" className="w-full rounded-full" data-attr="phone-bind-resend" onClick={send}>
            Text a new code
          </Button>
        </>
      )}
      {error ? (
        <p className="text-sm text-danger" role="alert" data-attr="phone-bind-error">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}
