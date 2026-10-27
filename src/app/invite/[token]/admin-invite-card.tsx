"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { ProfilePhoneCodeRow, useProfilePhoneVerify } from "@/components/portal/profile-phone-verify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { startOAuthSignIn } from "@/lib/auth/start-oauth-sign-in";
import { openServiceWorkspace } from "@/lib/service/open-service-workspace";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { OVERALL_ADMIN_LABEL } from "@/lib/admin-team/admin-team-model";

export type AdminInvitePreview = {
  ownerName: string;
  inviteeEmail?: string | null;
  adminRoleLabel?: string | null;
  adminWorkspaceNames?: string[];
};

/**
 * The page an Admin team invite link opens: "Create your admin account" for a new email (name, mobile with a text code,
 * Google or a password), or a plain accept for an account that is already signed in. The grant itself is whatever the
 * inviter stored on the link; nothing here names a role. Redeeming still requires the signed-in email to be the one the
 * link was sent to, which the server enforces.
 */
export function AdminInviteCard({ token, preview, signedIn, onSignedIn }: { token: string; preview: AdminInvitePreview; signedIn: boolean | null; onSignedIn: () => void }) {
  const router = useRouter();
  const invitePath = `/invite/${token}`;
  const boundEmail = preview.inviteeEmail ?? "";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState<(() => void) | null>(null);
  const [createdPhone, setCreatedPhone] = useState("");
  const [verified, setVerified] = useState(false);
  const phoneVerify = useProfilePhoneVerify({ phone: createdPhone, onVerified: () => setVerified(true) });

  const roleLabel = preview.adminRoleLabel ?? "Admin";
  const workspaces = preview.adminWorkspaceNames ?? [];
  const isOverall = roleLabel === OVERALL_ADMIN_LABEL;

  /** Redeems the link; the landing to run once the admin is done (after the optional mobile check), or null on failure. */
  const accept = useCallback(async (): Promise<(() => void) | null> => {
    setError(null);
    const res = await fetch("/api/pro/invite-links/redeem", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as { role?: string; workspaceIds?: string[]; error?: string };
    if (!res.ok) {
      setError(body.error ?? "Could not accept this invite.");
      return null;
    }
    const first = body.workspaceIds?.[0];
    return () => {
      if (body.role === "overall_admin") {
        router.replace("/admin/dashboard");
        return;
      }
      if (first) {
        void openServiceWorkspace(first, (href) => window.location.assign(href), { isAdmin: false });
        return;
      }
      router.replace("/portal/dashboard");
    };
  }, [router, token]);

  const run = async (work: () => Promise<(() => void) | null>, holdForPhone = false) => {
    setBusy(true);
    try {
      const go = await work();
      if (!go) return;
      // A number typed on this page gets its text code before the admin lands; everyone else goes straight in.
      if (holdForPhone) setLanding(() => go);
      else go();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const createAndAccept = async (): Promise<(() => void) | null> => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: boundEmail, password, fullName: name, phone }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(out.error ?? "Could not create your account.");
      return null;
    }
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: boundEmail, password });
    if (signInError) {
      setError("Account created. Sign in to finish accepting.");
      return null;
    }
    onSignedIn();
    setCreatedPhone(phone);
    return accept();
  };

  const google = async () => {
    setError(null);
    const result = await startOAuthSignIn({ supabase: createSupabaseBrowserClient(), provider: "google", nextPath: invitePath, viaContinue: false });
    if (!result.ok) setError(result.message);
  };

  const header = (
    <div className="flex flex-col items-center text-center" data-attr="admin-invite-header">
      <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
        {signedIn ? "Accept your PropLane admin invite" : "Create your admin account"}
      </h1>
      <p className="mt-1 text-[15px] text-foreground/80">{preview.ownerName} invited you</p>
    </div>
  );

  const terms = (
    <div className="mt-6" data-attr="admin-invite-terms">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Role">
          <span className="text-[15px] font-medium text-foreground" data-attr="admin-invite-role">{roleLabel}</span>
        </PortalSettingsRow>
        {!isOverall && workspaces.length > 0 ? (
          <PortalSettingsRow label={workspaces.length === 1 ? "Workspace" : "Workspaces"}>
            <span className="text-[15px] font-medium text-foreground" data-attr="admin-invite-workspaces">{workspaces.join(" · ")}</span>
          </PortalSettingsRow>
        ) : null}
        {boundEmail ? (
          <PortalSettingsRow label="Email">
            <span className="break-all text-[15px] font-medium text-foreground" data-attr="admin-invite-email">{boundEmail}</span>
          </PortalSettingsRow>
        ) : null}
      </PortalSettingsGroup>
    </div>
  );

  // Accepted: a number typed here gets its text code, then the admin lands.
  if (landing && createdPhone) {
    return (
      <AuthCard variant="blend">
        <div className="flex flex-col items-center text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Verify your mobile</h1>
        </div>
        <div className="mt-6 space-y-4" data-attr="admin-invite-phone">
          {phoneVerify.codeSent && !verified ? (
            <PortalSettingsGroup>
              <ProfilePhoneCodeRow phone={createdPhone} code={phoneVerify.code} onCodeChange={phoneVerify.setCode} error={phoneVerify.error} onConfirm={phoneVerify.confirm} />
            </PortalSettingsGroup>
          ) : null}
          {phoneVerify.error && !phoneVerify.codeSent ? <p className="text-center text-sm text-danger" role="alert">{phoneVerify.error}</p> : null}
          {verified ? (
            <Button type="button" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-continue" onClick={() => landing()}>
              Continue
            </Button>
          ) : (
            <>
              {!phoneVerify.codeSent ? (
                <Button type="button" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-send-code" onClick={() => phoneVerify.send()}>
                  Text me a code
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-skip-phone" onClick={() => landing()}>
                Skip for now
              </Button>
            </>
          )}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard variant="blend">
      {header}
      {terms}
      {error ? <p className="mt-4 text-center text-sm text-rose-600" role="alert">{error}</p> : null}
      <div className="mt-6">
        {signedIn === false ? (
          <form
            className="grid gap-3"
            data-attr="admin-invite-create"
            onSubmit={(event) => {
              event.preventDefault();
              void run(createAndAccept, Boolean(phone));
            }}
          >
            <Input aria-label="Full name" placeholder="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input aria-label="Email" type="email" value={boundEmail} readOnly />
            <PhoneNumberField value={phone} onChange={setPhone} dataAttr="admin-invite-phone-field" />
            <Input aria-label="Password" placeholder="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button
              type="submit"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              data-attr="admin-invite-create-submit"
              loading={busy}
              disabled={!boundEmail || name.trim().length < 2 || password.length < 8}
            >
              Create admin account
            </Button>
            <Button type="button" variant="outline" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-google" onClick={() => void google()}>
              Continue with Google
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              data-attr="admin-invite-sign-in"
              onClick={() => router.push(`/auth/sign-in?next=${encodeURIComponent(invitePath)}`)}
            >
              I already have an account
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="admin-invite-accept"
            loading={busy}
            onClick={() => void run(accept)}
          >
            Accept invite
          </Button>
        )}
      </div>
    </AuthCard>
  );
}
