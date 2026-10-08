import {
  Briefcase,
  Building,
  Camera,
  Globe,
  Home,
  MapPin,
  Megaphone,
  Share2,
  Sofa,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { ListingChannelId } from "@/lib/listing-channels/registry";

/**
 * The glyph and tone each listing channel's row wears. A leaf module on
 * purpose: the home page's Listing sites mock needs only this map, and reading
 * it from `listing-sites-panel.tsx` pulled that whole panel (and the portal
 * stores behind it) into the public bundle.
 */
export const CHANNEL_GLYPH: Record<ListingChannelId, { icon: LucideIcon; tone: string }> = {
  zillow: { icon: Home, tone: "text-blue-600" },
  facebook_page: { icon: Share2, tone: "text-sky-600" },
  instagram: { icon: Camera, tone: "text-pink-600" },
  facebook_marketplace: { icon: Share2, tone: "text-sky-600" },
  facebook_groups: { icon: Users, tone: "text-sky-600" },
  roomster: { icon: Users, tone: "text-emerald-600" },
  roomies: { icon: Users, tone: "text-violet-600" },
  furnished_finder: { icon: Sofa, tone: "text-amber-600" },
  craigslist: { icon: Megaphone, tone: "text-purple-600" },
  zumper_padmapper: { icon: MapPin, tone: "text-orange-600" },
  apartments_com: { icon: Building, tone: "text-teal-600" },
  apartment_list: { icon: Building, tone: "text-indigo-600" },
  spareroom: { icon: Home, tone: "text-rose-600" },
  nextdoor: { icon: Globe, tone: "text-green-600" },
  google_business_profile: { icon: MapPin, tone: "text-blue-600" },
  linkedin: { icon: Briefcase, tone: "text-sky-700" },
};
