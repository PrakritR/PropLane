"use client";

/** "Not you?": ends this session, then returns to the same authorize request after sign-in. */
export function McpSwitchAccountLink({ returnTo }: { returnTo: string }) {
  const signIn = `/auth/sign-in?next=${encodeURIComponent(returnTo)}`;
  return (
    <a
      href={signIn}
      data-attr="mcp-consent-switch-account"
      className="text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
      onClick={async (event) => {
        event.preventDefault();
        try {
          await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
        } catch {
          // Fall through: the sign-in page still lets them pick another account.
        }
        window.location.assign(signIn);
      }}
    >
      Not you? Switch account
    </a>
  );
}
