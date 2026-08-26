"use client";

import {
  BarChart3,
  BedDouble,
  Building2,
  Calendar,
  Circle,
  ClipboardList,
  CreditCard,
  DoorOpen,
  Folder,
  Inbox,
  LayoutDashboard,
  ListTodo,
  LogIn,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  ScrollText,
  UserCog,
  Settings,
  Smartphone,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Section id → community-standard lucide glyph. One source for every portal nav icon. */
const SECTION_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  properties: Building2,
  residents: Users,
  "axis-users": Users,
  leases: ScrollText,
  lease: ScrollText,
  calendar: Calendar,
  // Occupancy / channel stays — distinct from Calendar (schedule + availability) sitting above it.
  bookings: BedDouble,
  "task-list": ListTodo,
  // A tour is someone being shown a place, so it gets its own glyph rather than falling through
  // to the `?? Circle` default — which is what put an empty circle in the nav — and rather than
  // reusing Calendar, which already means the Calendar section sitting a few rows below it.
  tours: DoorOpen,
  tour: DoorOpen,
  events: Calendar,
  applications: ClipboardList,
  payments: CreditCard,
  documents: Folder,
  financials: BarChart3,
  services: Wrench,
  "work-orders": Wrench,
  vendors: Truck,
  inbox: Inbox,
  communication: MessagesSquare,
  "bugs-feedback": MessageSquare,
  profile: Settings,
  settings: Settings,
  plan: CreditCard,
  relationships: UserCog,
  "move-in": LogIn,
  promotion: Megaphone,
  app: Smartphone,
};

/**
 * Portal nav icon — Lucide outline by default; filled when `active` (Instagram tab convention).
 * One family, one optical size; stroke weight steps with selection state.
 */
export function PortalNavIcon({
  section,
  className,
  strokeWidth,
  active = false,
}: {
  section: string;
  className?: string;
  strokeWidth?: number;
  /** Selected tab / active nav destination — outline → filled. */
  active?: boolean;
}) {
  const Icon = SECTION_ICONS[section] ?? Circle;
  const resolvedStroke = strokeWidth ?? (active ? 2.25 : 1.75);
  return (
    <Icon
      className={cn(className ?? "h-[18px] w-[18px] shrink-0", active && "text-primary")}
      strokeWidth={resolvedStroke}
      fill={active ? "currentColor" : "none"}
      fillOpacity={active ? 0.22 : 0}
      aria-hidden
    />
  );
}

/** @deprecated Use PortalNavIcon */
export const AdminPortalNavIcon = PortalNavIcon;
