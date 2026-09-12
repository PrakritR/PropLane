"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12h16m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
}: Navbar1Props) {
  return (
    <div className="mx-auto flex min-h-[56px] w-full max-w-6xl items-center px-4 sm:px-5">
      {/* Desktop — logo left, links centered, actions right (3-col grid). */}
      <nav className="hidden w-full grid-cols-[auto_1fr_auto] items-center gap-4 lg:grid">
        <div className="justify-self-start">{logoSlot}</div>
        <div className="justify-self-center">
          <NavigationMenu>
            <NavigationMenuList>
              {menu.map((item) => (
                <DesktopMenuItem key={item.title} item={item} />
              ))}
            </NavigationMenuList>
          </NavigationMenu>
        </div>
        <div className="flex items-center gap-2 justify-self-end whitespace-nowrap">
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
              <Link
                href={auth.login.url}
                className="mr-1 inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-2 text-sm font-semibold text-foreground transition-colors hover:text-primary"
              >
                {auth.login.text}
                <ArrowRightIcon className="size-4" />
              </Link>
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
              <Button
                asChild
                className="btn-brand-cta h-9 min-h-0 whitespace-nowrap px-4 text-[13px] text-white hover:brightness-110"
              >
                <Link href={auth.signup.url}>{auth.signup.text}</Link>
              </Button>
            </>
          )}
        </div>
      </nav>

      {/* Mobile */}
      <div className="flex w-full items-center justify-between lg:hidden">
        {logoSlot}
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
              <Accordion type="single" collapsible className="flex w-full flex-col gap-4">
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
                  <Button asChild variant="outline">
                    <Link href={auth.login.url}>{auth.login.text}</Link>
                  </Button>
                  <Button
                    asChild
                    className="btn-brand-cta text-white hover:brightness-110"
                  >
                    <Link href={auth.signup.url}>{auth.signup.text}</Link>
                  </Button>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

function DesktopMenuItem({ item }: { item: NavbarMenuItem }) {
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
                    >
                      {subItem.icon}
                      <div>
                        <div className="text-sm font-semibold">{subItem.title}</div>
                        {subItem.description && (
                          <p className="text-sm leading-snug text-muted">{subItem.description}</p>
                        )}
                      </div>
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
  if (item.items) {
    return (
      <AccordionItem value={item.title} className="border-b-0">
        <AccordionTrigger className="py-0 text-[14px] font-semibold hover:no-underline">
          {item.title}
        </AccordionTrigger>
        <AccordionContent className="mt-2">
          {item.items.map((subItem) => {
            const isActive = item.activeChildHref === subItem.url;
            return (
              <Link
                key={subItem.title}
                href={subItem.url}
                className={cn(
                  "flex min-h-[44px] select-none gap-4 rounded-xl p-3 leading-none outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-accent font-semibold text-primary",
                )}
              >
                {subItem.icon}
                <div>
                  <div className="text-sm font-semibold">{subItem.title}</div>
                  {subItem.description && (
                    <p className="text-sm leading-snug text-muted">{subItem.description}</p>
                  )}
                </div>
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
        "flex min-h-[44px] items-center text-[14px] font-semibold",
        item.active && "text-primary",
      )}
    >
      {item.title}
    </Link>
  );
}
