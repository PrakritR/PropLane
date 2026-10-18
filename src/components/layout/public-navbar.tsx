"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { HomeNavbar, type HomeTextingConfig } from "@/components/layout/home-navbar";

const LegacyPublicNavbar = dynamic(() => import("@/components/layout/legacy-public-navbar").then((module) => module.LegacyPublicNavbar));
const NO_TEXTING: HomeTextingConfig = { phone: null, smsHref: null };

/** Home avoids loading the full product menu, search overlay, and auth lookups. */
export function PublicNavbar({ texting = NO_TEXTING }: { texting?: HomeTextingConfig }) {
  return usePathname() === "/" ? <HomeNavbar texting={texting} /> : <LegacyPublicNavbar />;
}
