import { iosAppDownloadIsTestFlight, iosAppDownloadUrl } from "@/lib/ios-app-download";
import { cn } from "@/lib/utils";

/**
 * The one App Store badge every public surface uses (footer, hero, /app).
 * Black on light backgrounds, white on dark ones (`tone="light"`) — never
 * recoloured beyond that, and the label flips to TestFlight while the download
 * URL points at a beta link.
 */
export function AppStoreBadge({
  tone = "dark",
  size = "md",
  className,
  dataAttr = "app-store-badge",
}: {
  tone?: "dark" | "light";
  size?: "md" | "lg";
  className?: string;
  dataAttr?: string;
}) {
  const url = iosAppDownloadUrl();
  const beta = iosAppDownloadIsTestFlight(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-attr={dataAttr}
      aria-label={beta ? "Join the PropLane beta on TestFlight" : "Download PropLane on the App Store"}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        size === "lg" ? "h-12 px-4" : "h-9 px-3",
        tone === "dark"
          ? "border-foreground/80 bg-foreground text-background [html[data-theme=dark]_&]:border-border [html[data-theme=dark]_&]:bg-card [html[data-theme=dark]_&]:text-foreground"
          : "border-white/90 bg-white text-[#0b1120]",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} fill="currentColor" aria-hidden>
        <path d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.8 1.3 10.3.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.8-4.2ZM14 5.2c.7-.8 1.2-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.5 2.9-1.3Z" />
      </svg>
      <span className="leading-none">
        <span className={cn("block font-medium uppercase tracking-wide opacity-80", size === "lg" ? "text-[10px]" : "text-[9px]")}>
          {beta ? "Join the beta on" : "Download on the"}
        </span>
        <span className={cn("block font-bold", size === "lg" ? "text-[15px]" : "text-[13px]")}>{beta ? "TestFlight" : "App Store"}</span>
      </span>
    </a>
  );
}
