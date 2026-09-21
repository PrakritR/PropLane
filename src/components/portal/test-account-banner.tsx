import { ShieldCheck } from "lucide-react";

export function TestAccountBanner({ state }: { state: "active" | "suspended" | "expired" }) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/[0.07] px-4 text-xs font-medium text-foreground sm:px-5" data-attr="test-account-banner">
      <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span>
        Test account
        {state === "active" ? " · External deliveries are captured." : " · Access is suspended; live delivery stays blocked."}
      </span>
    </div>
  );
}
