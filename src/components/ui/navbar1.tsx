"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { PublicSearchOverlay, type PublicSearchItem } from "@/components/layout/public-search-overlay";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface NavbarMenuItem {
  title: string;
  url: string;
  description?: string;
  icon?: ReactNode;
  items?: NavbarMenuItem[];
  /**
   * A mega menu: named columns of links, optionally with a featured panel on
   * the right. When present, `items` is ignored on desktop and the groups are
   * flattened under their headings on the phone sheet.
   */
  groups?: { heading: string; items: NavbarMenuItem[] }[];
  /** A large leading link in its own column, before the groups (e.g. "Explore Product"). */
  intro?: { title: string; url: string; dataAttr?: string };
  featured?: ReactNode;
  active?: boolean;
  activeChildHref?: string;
  dataAttr?: string;
}

export interface Navbar1Props {
  logoSlot?: ReactNode;
  menu?: NavbarMenuItem[];
  auth?: {
    login: { text: string; url: string };
    signup: { text: string; url: string };
    /** A quieter second door beside the primary (Book a demo). Desktop only. */
    secondary?: { text: string; url: string; dataAttr?: string };
  };
  portalLink?: { text: string; url: string };
  actionsSlot?: ReactNode;
  /** Pinned under the phone sheet's buttons (e.g. the App Store badge). */
  mobileFooter?: ReactNode;
  /** Real routes the search overlay can jump to. Omit to hide the search icon. */
  searchItems?: PublicSearchItem[];
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 17 17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Navbar1({
  logoSlot,
  menu = [],
  auth = {
    login: { text: "Log in", url: "#" },
    signup: { text: "Sign up", url: "#" },
  },
  portalLink,
  actionsSlot,
  mobileFooter,
  searchItems,
}: Navbar1Props) {
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl+K opens search, matching the same shortcut the signed-in
  // portal's own "Ask PropLane" pill already uses.
  useEffect(() => {
    if (!searchItems) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchItems]);

  return (
    <div className="mx-auto flex min-h-[56px] w-full max-w-6xl items-center px-4 sm:px-5">
      {/* Desktop — logo and links left-justified together, actions right
          (4-col grid: logo | menu | flexible spacer | actions). Captain
          2026-09-25: the links sit right next to the mark, not centered. */}
      <nav className="hidden w-full grid-cols-[auto_auto_1fr_auto] items-center gap-6 lg:grid">
        <div className="justify-self-start">{logoSlot}</div>
        <div className="justify-self-start">
          <NavigationMenu>
            <NavigationMenuList>
              {menu.map((item) => (
                <DesktopMenuItem key={item.title} item={item} />
              ))}
            </NavigationMenuList>
          </NavigationMenu>
        </div>
        <div aria-hidden />
        <div className="flex items-center gap-2 justify-self-end whitespace-nowrap">
          {searchItems ? (
            <button
              type="button"
              aria-label="Search PropLane (Cmd+K)"
              data-attr="public-nav-search"
              onClick={() => setSearchOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-accent/60 hover:text-foreground"
            >
              <Search className="size-[17px]" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
          {actionsSlot && <div className="hidden items-center lg:flex">{actionsSlot}</div>}
          {portalLink ? (
            <Button
              asChild
              className="btn-brand-cta h-9 min-h-0 px-4 text-[13px] text-white hover:brightness-110"
            >
              <Link href={portalLink.url}>{portalLink.text}</Link>
            </Button>
          ) : (
            <>
              {auth.secondary ? (
                <Button
                  asChild
                  variant="outline"
                  className="h-9 min-h-0 whitespace-nowrap rounded-full border-border bg-card px-4 text-[13px] shadow-none"
                >
                  <Link href={auth.secondary.url} data-attr={auth.secondary.dataAttr}>
                    {auth.secondary.text}
                  </Link>
                </Button>
              ) : null}
              <Link
                href={auth.login.url}
                className="inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-2 text-sm font-semibold text-foreground transition-colors hover:text-primary"
              >
                {auth.login.text}
              </Link>
              <Button
                asChild
                className="btn-brand-cta inline-flex h-9 min-h-0 items-center gap-1.5 whitespace-nowrap px-4 text-[13px] text-white hover:brightness-110"
              >
                <Link href={auth.signup.url}>
                  {auth.signup.text}
                  <ArrowUpRightIcon className="size-3.5" />
                </Link>
              </Button>
            </>
          )}
        </div>
      </nav>

      {searchItems ? <PublicSearchOverlay items={searchItems} open={searchOpen} onOpenChange={setSearchOpen} /> : null}

      {/* Mobile */}
      <div className="flex w-full items-center justify-between lg:hidden">
        {logoSlot}
        <div className="flex items-center gap-1.5">
          {searchItems ? (
            <button
              type="button"
              aria-label="Search PropLane"
              data-attr="public-nav-search-mobile"
              onClick={() => setSearchOpen(true)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-foreground/85 transition hover:bg-accent/60"
            >
              <Search className="size-[19px]" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
          <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="h-10 w-10 min-h-0 shrink-0 rounded-full border-border/80 bg-background px-0 text-foreground shadow-none hover:bg-accent/60"
              aria-label="Open menu"
              data-attr="public-nav-menu-toggle"
            >
              <MenuIcon className="size-[22px] shrink-0" />
            </Button>
          </SheetTrigger>
          <SheetContent className="overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{logoSlot}</SheetTitle>
            </SheetHeader>
            <div className="my-6 flex flex-col gap-6">
              <Accordion type="single" collapsible className="flex w-full flex-col divide-y divide-border">
                {menu.map((item) => (
                  <MobileMenuItem key={item.title} item={item} />
                ))}
              </Accordion>
              {actionsSlot && (
                <div className="flex justify-center border-t border-border pt-4">{actionsSlot}</div>
              )}
              {portalLink ? (
                <Button
                  asChild
                  className="btn-brand-cta text-white hover:brightness-110"
                >
                  <Link href={portalLink.url}>{portalLink.text}</Link>
                </Button>
              ) : (
                <div className="flex flex-col gap-3">
                  <Button
                    asChild
                    className="btn-brand-cta inline-flex items-center justify-center gap-1.5 text-white hover:brightness-110"
                  >
                    <Link href={auth.signup.url}>
                      {auth.signup.text}
                      <ArrowUpRightIcon className="size-3.5" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={auth.login.url}>{auth.login.text}</Link>
                  </Button>
                </div>
              )}
              {mobileFooter ? <div className="flex justify-center">{mobileFooter}</div> : null}
            </div>
          </SheetContent>
          </Sheet>
        </div>
      </div>
    </div>
  );
}

/** No subtext under a nav link (captain 2026-09-25's full-width mega menu
 * spec) — the label alone, same "no caption under a label" rule the rest of
 * the product's UI follows. `item.description` still exists on the data for
 * an `aria-label` a screen reader can use, but nothing renders it visually. */
function MegaLink({ item, active }: { item: NavbarMenuItem; active: boolean }) {
  return (
    <NavigationMenuLink asChild>
      <Link
        href={item.url}
        data-attr={item.dataAttr}
        aria-label={item.description ? `${item.title} — ${item.description}` : undefined}
        className={cn(
          "flex select-none items-center gap-3 rounded-xl px-2.5 py-2.5 leading-none no-underline outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
          active && "bg-accent text-primary",
        )}
      >
        {item.icon ? (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&>svg]:h-4 [&>svg]:w-4">
            {item.icon}
          </span>
        ) : null}
        <span className="truncate text-[13.5px] font-semibold">{item.title}</span>
      </Link>
    </NavigationMenuLink>
  );
}

function DesktopMenuItem({ item }: { item: NavbarMenuItem }) {
  if (item.groups) {
    return (
      <NavigationMenuItem>
        <NavigationMenuTrigger className={cn(item.active && "bg-card text-primary", !item.active && "text-foreground/85")}>
          {item.title}
        </NavigationMenuTrigger>
        <NavigationMenuContent>
          {/* Full-width panel (captain 2026-09-25): the background/border
              spans the whole viewport (see NavigationMenuViewport); this
              inner wrapper keeps the actual content at the same measure as
              the rest of the site instead of stretching links edge to edge. */}
          <div className="mx-auto flex w-full max-w-6xl gap-8 px-6 py-7">
            {item.intro ? (
              <Link
                href={item.intro.url}
                data-attr={item.intro.dataAttr}
                className="flex w-[220px] shrink-0 flex-col justify-between rounded-2xl bg-primary/[0.06] p-5 no-underline transition-colors hover:bg-primary/[0.09]"
              >
                <span className="text-[19px] font-bold leading-tight tracking-[-0.01em] text-foreground">{item.intro.title}</span>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-bold text-primary">
                  Explore <ArrowUpRightIcon className="size-3.5" />
                </span>
              </Link>
            ) : null}
            <div className={cn("flex flex-1 gap-8", item.featured ? "" : "")}>
              {item.groups.map((g) => (
                <div key={g.heading} className="min-w-0 flex-1">
                  <p className="px-2.5 pb-1.5 pt-1 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-muted">{g.heading}</p>
                  <ul className="flex flex-col gap-0.5">
                    {g.items.map((sub) => (
                      <li key={sub.title}>
                        <MegaLink item={sub} active={item.activeChildHref === sub.url} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {item.featured ? <div className="w-[210px] shrink-0">{item.featured}</div> : null}
          </div>
        </NavigationMenuContent>
      </NavigationMenuItem>
    );
  }
  if (item.items) {
    return (
      <NavigationMenuItem>
        <NavigationMenuTrigger
          className={cn(
            item.active && "bg-card text-primary",
            !item.active && "text-foreground/85",
          )}
        >
          {item.title}
        </NavigationMenuTrigger>
        <NavigationMenuContent>
          <ul className="w-80 p-3">
            {item.items.map((subItem) => {
              const isActive = item.activeChildHref === subItem.url;
              return (
                <li key={subItem.title}>
                  <NavigationMenuLink asChild>
                    <Link
                      href={subItem.url}
                      className={cn(
                        "flex select-none gap-4 rounded-xl p-3 leading-none no-underline outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                        isActive && "bg-accent text-primary",
                      )}
                      aria-label={subItem.description ? `${subItem.title} — ${subItem.description}` : undefined}
                    >
                      {subItem.icon}
                      <div className="text-sm font-semibold">{subItem.title}</div>
                    </Link>
                  </NavigationMenuLink>
                </li>
              );
            })}
          </ul>
        </NavigationMenuContent>
      </NavigationMenuItem>
    );
  }

  return (
    <NavigationMenuItem>
      <NavigationMenuLink asChild>
        <Link
          href={item.url}
          data-attr={item.dataAttr}
          className={cn(
            "group inline-flex h-10 min-h-[44px] w-max items-center justify-center rounded-full px-4 py-2 text-[14px] font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
            item.active ? "bg-card text-primary" : "text-foreground/85",
          )}
        >
          {item.title}
        </Link>
      </NavigationMenuLink>
    </NavigationMenuItem>
  );
}

function MobileMenuItem({ item }: { item: NavbarMenuItem }) {
  const subItems = item.groups ? item.groups.flatMap((g) => g.items) : item.items;
  if (subItems) {
    return (
      <AccordionItem value={item.title} className="border-b-0">
        <AccordionTrigger className="min-h-[48px] py-0 text-[15px] font-semibold hover:no-underline">
          {item.title}
        </AccordionTrigger>
        <AccordionContent className="pb-3">
          {item.intro ? (
            <Link
              href={item.intro.url}
              className="mb-1 flex min-h-[44px] items-center justify-between gap-2 rounded-xl bg-primary/[0.06] p-3 text-[14px] font-bold text-foreground"
            >
              {item.intro.title}
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-primary" />
            </Link>
          ) : null}
          {subItems.map((subItem) => {
            const isActive = item.activeChildHref === subItem.url;
            return (
              <Link
                key={subItem.title}
                href={subItem.url}
                aria-label={subItem.description ? `${subItem.title} — ${subItem.description}` : undefined}
                className={cn(
                  "flex min-h-[44px] select-none items-center gap-4 rounded-xl p-3 leading-none outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-accent font-semibold text-primary",
                )}
              >
                {subItem.icon ? (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary [&>svg]:h-4 [&>svg]:w-4">
                    {subItem.icon}
                  </span>
                ) : null}
                <div className="text-sm font-semibold">{subItem.title}</div>
              </Link>
            );
          })}
        </AccordionContent>
      </AccordionItem>
    );
  }

  return (
    <Link
      href={item.url}
      data-attr={item.dataAttr}
      className={cn(
        "flex min-h-[48px] items-center text-[15px] font-semibold",
        item.active && "text-primary",
      )}
    >
      {item.title}
    </Link>
  );
}
