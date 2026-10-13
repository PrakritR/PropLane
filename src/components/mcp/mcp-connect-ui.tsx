import Link from "next/link";
import type { ReactNode } from "react";
import { TriangleAlert, type LucideIcon } from "lucide-react";
import { AuthCard } from "@/components/auth/auth-card";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { cn } from "@/lib/utils";

/** The card every MCP connection screen sits in, inside the auth split shell (`src/app/mcp/layout.tsx`). */
export function McpConnectShell({ children }: { children: ReactNode }) {
  return <AuthCard variant="blend">{children}</AuthCard>;
}

/** Icon tile and a heading: the head of every MCP connection screen. */
export function McpConnectHead({ icon: Icon, title, tone = "primary" }: { icon: LucideIcon; title: string; tone?: "primary" | "success" | "danger" }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-[18px]",
          tone === "success" && "bg-emerald-500/10 text-emerald-600",
          tone === "danger" && "border border-danger/30 bg-danger/5 text-danger",
          tone === "primary" && "bg-primary/10 text-primary",
        )}
        aria-hidden
      >
        <Icon className="h-6 w-6" strokeWidth={1.75} />
      </div>
      <h1 className="mt-4 break-words text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
    </div>
  );
}

/** Label/value rows in the settings-kit look. */
export function McpConnectRows({ rows }: { rows: { label: string; value: ReactNode; attr?: string }[] }) {
  return (
    <div className="mt-6" data-attr="mcp-connect-rows">
      <PortalSettingsGroup>
        {rows.map((row) => (
          <PortalSettingsRow key={row.label} label={row.label}>
            <span className="block break-words text-[15px] font-medium text-foreground" data-attr={row.attr}>{row.value}</span>
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
    </div>
  );
}

/** Error state: icon, title, one row, and a way out. Never a dead end. */
export function McpConnectNotice({ title, line, actionHref = "/portal", actionLabel = "Open PropLane" }: { title: string; line: string; actionHref?: string; actionLabel?: string }) {
  return (
    <McpConnectShell>
      <McpConnectHead icon={TriangleAlert} title={title} tone="danger" />
      <McpConnectRows rows={[{ label: "Status", value: line }]} />
      <Link
        href={actionHref}
        data-attr="mcp-connect-notice-continue"
        className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-primary/30 px-5 text-sm font-semibold text-primary outline-none transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary/25 lg:min-h-8 lg:rounded-[var(--radius-control)]"
      >
        {actionLabel}
      </Link>
    </McpConnectShell>
  );
}
